import fs from "node:fs";
import path from "node:path";
import { ApiError, GoogleGenAI, Modality, type Part } from "@google/genai";
import sharp from "sharp";
import { config } from "./config.js";
import { db } from "./db.js";

/**
 * Images seen in each chat (photos people sent, and ones Friday made), numbered so Claude can say
 * "edit image #12". Files live in DATA_DIR/images and are pruned after IMAGE_RETENTION_DAYS.
 */
export type StoredImage = { id: number; chatId: string; mimetype: string; data: Buffer };

const IMAGE_RETENTION_DAYS = 30;
const imageDir = path.join(config.DATA_DIR, "images");
fs.mkdirSync(imageDir, { recursive: true });

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const fileFor = (id: number, mimetype: string) => path.join(imageDir, `${id}.${EXT[mimetype] ?? "img"}`);

export function saveImage(chatId: string, mimetype: string, data: Buffer): number {
  const result = db.prepare("INSERT INTO images (chat_id, mimetype, created_at) VALUES (?, ?, ?)").run(chatId, mimetype, Date.now());
  const id = Number(result.lastInsertRowid);
  fs.writeFileSync(fileFor(id, mimetype), data);
  return id;
}

/** Loads an image, but only from the chat it was seen in. */
export function loadImage(id: number, chatId: string): StoredImage | undefined {
  const row = db.prepare("SELECT mimetype FROM images WHERE id = ? AND chat_id = ?").get(id, chatId) as { mimetype: string } | undefined;
  if (!row || !fs.existsSync(fileFor(id, row.mimetype))) return undefined;
  return { id, chatId, mimetype: row.mimetype, data: fs.readFileSync(fileFor(id, row.mimetype)) };
}

export function pruneImages(now = Date.now()): void {
  const cutoff = now - IMAGE_RETENTION_DAYS * 86_400_000;
  const old = db.prepare("SELECT id, mimetype FROM images WHERE created_at < ?").all(cutoff) as { id: number; mimetype: string }[];
  for (const img of old) fs.rmSync(fileFor(img.id, img.mimetype), { force: true });
  db.prepare("DELETE FROM images WHERE created_at < ?").run(cutoff);
}

export type ImageRequest = {
  prompt: string;
  inputs?: { mimetype: string; data: Buffer }[]; // images to edit or combine
  aspectRatio?: string; // "1:1", "16:9", ...
};
export type ImageResult = { mimetype: string; data: Buffer };

const provider =
  config.IMAGE_PROVIDER === "cloudflare" && config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN
    ? "cloudflare"
    : config.IMAGE_PROVIDER === "gemini" && config.GEMINI_API_KEY
      ? "gemini"
      : undefined;

export const imagesEnabled = provider !== undefined;
export const imageProvider = provider;

/** Creates (no inputs) or edits (with inputs) an image. Throws with a readable message on failure. */
export function makeImage(req: ImageRequest): Promise<ImageResult> {
  if (provider === "cloudflare") return cloudflareImage(req);
  if (provider === "gemini") return geminiImage(req);
  throw new Error("Image generation isn't set up. (Admin: add Cloudflare credentials to .env.)");
}

function sniffMimetype(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "image/png";
}

/** Output size for an aspect ratio, about one megapixel, in multiples of 16. */
export function outputSize(aspectRatio: string | undefined, fallback?: { width: number; height: number }): { width: number; height: number } {
  const [w, h] = aspectRatio?.split(":").map(Number) ?? (fallback ? [fallback.width, fallback.height] : [1, 1]);
  const ratio = w > 0 && h > 0 ? w / h : 1;
  const round = (n: number) => Math.min(1920, Math.max(256, Math.round(n / 16) * 16));
  return { width: round(Math.sqrt(1024 * 1024 * ratio)), height: round(Math.sqrt((1024 * 1024) / ratio)) };
}

/** Cloudflare Workers AI (FLUX.2) — the free plan covers roughly 90 images a day. */
async function cloudflareImage(req: ImageRequest): Promise<ImageResult> {
  const inputs = req.inputs ?? [];
  const first = inputs[0] && (await sharp(inputs[0].data).rotate().metadata());
  const size = outputSize(req.aspectRatio, first?.width && first.height ? { width: first.width, height: first.height } : undefined);

  const form = new FormData();
  form.append("prompt", req.prompt);
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  for (const [i, img] of inputs.slice(0, 4).entries()) {
    // The model takes reference images up to 512×512.
    const small = await sharp(img.data).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    form.append(`input_image_${i}`, new Blob([new Uint8Array(small)], { type: "image/jpeg" }), `input_${i}.jpg`);
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/ai/run/${config.CLOUDFLARE_IMAGE_MODEL}`,
    { method: "POST", headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` }, body: form },
  );
  if (res.headers.get("content-type")?.startsWith("image/")) {
    return { mimetype: res.headers.get("content-type")!, data: Buffer.from(await res.arrayBuffer()) };
  }
  const body = (await res.json().catch(() => ({}))) as {
    result?: { image?: string };
    image?: string;
    errors?: { message?: string }[];
  };
  const b64 = body.result?.image ?? body.image;
  if (!res.ok || !b64) {
    const reason = body.errors?.map((e) => e.message).join("; ") || res.statusText;
    if (res.status === 429 || /neuron|quota|limit/i.test(reason)) {
      throw new Error("Today's free image allowance is used up. It resets daily (00:00 UTC).");
    }
    throw new Error(`The image service returned an error (${res.status}): ${reason.slice(0, 300)}`);
  }
  const data = Buffer.from(b64, "base64");
  return { mimetype: sniffMimetype(data), data };
}

/** Google Gemini ("Nano Banana") — paid only; no free tier for image output. */
async function geminiImage(req: ImageRequest): Promise<ImageResult> {
  const gemini = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  const parts: Part[] = [
    { text: req.prompt },
    ...(req.inputs ?? []).map((img) => ({ inlineData: { mimeType: img.mimetype, data: img.data.toString("base64") } })),
  ];
  let response;
  try {
    response = await gemini.models.generateContent({
      model: config.GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: [Modality.IMAGE, Modality.TEXT],
        ...(req.aspectRatio && { imageConfig: { aspectRatio: req.aspectRatio } }),
      },
    });
  } catch (err) {
    if (err instanceof ApiError) throw new Error(`The image service returned an error (${err.status}): ${err.message.slice(0, 300)}`);
    throw err;
  }
  if (response.promptFeedback?.blockReason) {
    throw new Error(`The image service declined this request (${response.promptFeedback.blockReason}). Try rephrasing it.`);
  }
  const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!image?.inlineData?.data) {
    throw new Error(`No image came back (${response.candidates?.[0]?.finishReason ?? "unknown reason"}). Try rephrasing the request.`);
  }
  return { mimetype: image.inlineData.mimeType ?? "image/png", data: Buffer.from(image.inlineData.data, "base64") };
}
