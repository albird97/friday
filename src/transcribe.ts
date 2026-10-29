import { config } from "./config.js";

// Voice notes → text with Whisper on Cloudflare Workers AI, the same free daily allowance as pictures (a 1-minute voice
// note costs about 50 of its 10,000 daily "neurons"). Friday answers in text; it never speaks.

export const transcriptionEnabled = Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN);
export const MAX_VOICE_BYTES = 15 * 1024 * 1024;

/** The words in a voice note (any language Whisper knows; it detects which). Throws with a readable message. */
export async function transcribe(audio: Buffer): Promise<string> {
  if (!transcriptionEnabled) throw new Error("Voice notes can't be transcribed (Cloudflare isn't set up).");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/ai/run/${config.CLOUDFLARE_STT_MODEL}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: audio.toString("base64") }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const json = (await res.json().catch(() => undefined)) as
    | { success?: boolean; result?: { text?: string }; errors?: { message?: string }[] }
    | undefined;
  if (res.status === 429 || /neuron|quota|limit/i.test(json?.errors?.[0]?.message ?? "")) {
    throw new Error("Today's free Cloudflare allowance is used up; voice notes work again tomorrow.");
  }
  if (!res.ok || !json?.success) throw new Error(`Cloudflare couldn't transcribe it: ${json?.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return (json.result?.text ?? "").trim();
}
