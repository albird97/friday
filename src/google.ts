import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { expireSession } from "./session.js";
import type { ChatContext, Outbox } from "./types.js";

// Each contact links their own Google account from their private chat, so Friday acts on that person's calendar, mail
// and files and nobody else's. The account is looked up from the sender's number, never from anything Claude passes.
// Refresh tokens are encrypted at rest with GOOGLE_TOKEN_KEY, which lives only in .env.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const LINK_MINUTES = 10;

const SCOPE = "https://www.googleapis.com/auth/";
export const SCOPES = {
  calendar: `${SCOPE}calendar.events`,
  tasks: `${SCOPE}tasks`,
  driveRead: `${SCOPE}drive.readonly`,
  driveFile: `${SCOPE}drive.file`,
  sheets: `${SCOPE}spreadsheets`,
  docs: `${SCOPE}documents`,
  slides: `${SCOPE}presentations`,
  contacts: `${SCOPE}contacts.readonly`,
  gmailRead: `${SCOPE}gmail.readonly`,
  gmailCompose: `${SCOPE}gmail.compose`,
  gmailSend: `${SCOPE}gmail.send`,
  forms: `${SCOPE}forms.body`,
  formResponses: `${SCOPE}forms.responses.readonly`,
  youtube: `${SCOPE}youtube.readonly`,
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const googleEnabled = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.PUBLIC_URL && /^[0-9a-f]{64}$/i.test(config.GOOGLE_TOKEN_KEY));
export const redirectUri = () => `${config.PUBLIC_URL}/oauth/google/callback`;

/** Google never reaches groups: other people read every reply there. */
export function googleAllowed(chat: ChatContext): boolean {
  return googleEnabled && !chat.isGroup && chat.sender.isContact;
}

// --- Token storage -------------------------------------------------------------------------------------------------

const key = () => Buffer.from(config.GOOGLE_TOKEN_KEY, "hex");

export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export type GoogleAccount = { number: string; email: string; scopes: string[] };

export function googleAccount(number: string): GoogleAccount | undefined {
  const row = db.prepare("SELECT number, email, scopes FROM google_accounts WHERE number = ?").get(number) as { number: string; email: string; scopes: string } | undefined;
  return row && { ...row, scopes: row.scopes.split(" ") };
}

// --- Linking an account --------------------------------------------------------------------------------------------

/** A one-time link to Google's consent screen, tied to this person's number. */
export function connectLink(number: string, now = Date.now()): string {
  const state = randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM google_links WHERE number = ? OR created_at < ?").run(number, now - LINK_MINUTES * 60_000);
  db.prepare("INSERT INTO google_links (state, number, created_at) VALUES (?, ?, ?)").run(state, number, now);
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: ["openid", "email", ...Object.values(SCOPES)].join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

/** What someone reads before they agree. Google's policy wants this said plainly, ahead of the consent screen. */
export function connectMessage(number: string, adminName: string): string {
  return [
    "🔗 *Hubungkan akun Google*",
    `Kalau kamu setuju, ${config.BOT_NAME} bisa memakai Calendar, Tasks, Gmail, Drive, Docs, Sheets, Slides, Forms, Contacts, dan YouTube milikmu, hanya saat kamu memintanya di chat pribadi ini.`,
    [
      "*Sebelum setuju, perlu kamu tahu:*",
      `- Isi yang dibaca ${config.BOT_NAME} dikirim ke Claude (Anthropic) untuk diproses.`,
      `- Isinya tersimpan sementara di riwayat chat, di server yang dikelola ${adminName}.`,
      "- Setiap perubahan, seperti kirim email atau ubah acara, harus kamu konfirmasi dengan kode.",
      "- Kamu bisa memutus akses kapan saja dengan /google putus.",
    ].join("\n"),
    `Kebijakan privasi: ${config.PUBLIC_URL}/privacy`,
    `Google akan menampilkan peringatan aplikasi belum diverifikasi, karena ${config.BOT_NAME} dipakai terbatas oleh keluarga dan teman ${adminName}. Di layar berikutnya kamu bisa memilih izin mana yang diberikan.`,
    `Link ini berlaku ${LINK_MINUTES} menit dan hanya untukmu:\n${connectLink(number)}`,
  ].join("\n\n");
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!res.ok) throw new GoogleAuthError(body.error ?? `HTTP ${res.status}`);
  return body;
}

export class GoogleAuthError extends Error {}

/** Google's redirect back. `outbox` tells the person on WhatsApp how it went. Returns the page to show in their browser. */
export async function finishConnect(state: string, code: string | undefined, outbox: Outbox, now = Date.now()): Promise<{ ok: boolean; title: string; text: string }> {
  const link = db.prepare("DELETE FROM google_links WHERE state = ? RETURNING number, created_at").get(state) as { number: string; created_at: number } | undefined;
  if (!link || now - link.created_at > LINK_MINUTES * 60_000) {
    return { ok: false, title: "Link sudah tidak berlaku", text: `Kirim /google ke ${config.BOT_NAME} untuk mendapatkan link baru.` };
  }
  const chatId = outbox.chatIdFor(link.number);
  if (!code) {
    await outbox.sendText(chatId, "Akun Google tidak jadi dihubungkan. Kirim /google kalau berubah pikiran.");
    return { ok: false, title: "Tidak jadi dihubungkan", text: "Tidak ada akses yang diberikan. Kamu bisa menutup halaman ini." };
  }
  try {
    const token = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
    if (!token.refresh_token) throw new GoogleAuthError("no refresh token");
    const payload = JSON.parse(Buffer.from((token.id_token ?? "..").split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { email?: string };
    const email = payload.email ?? "akun Google";
    db.prepare("INSERT OR REPLACE INTO google_accounts (number, email, refresh_token, scopes, connected_at) VALUES (?, ?, ?, ?, ?)").run(
      link.number,
      email,
      encrypt(token.refresh_token),
      token.scope ?? "",
      now,
    );
    tokens.delete(link.number);
    expireSession(chatId); // tools and the system prompt are fixed for a session
    await outbox.sendText(chatId, `✅ Akun Google terhubung: ${email}\nCoba tulis: "Besok aku ada acara apa?"`);
    return { ok: true, title: "Akun Google terhubung", text: `Kamu bisa kembali ke WhatsApp dan melanjutkan chat dengan ${config.BOT_NAME}.` };
  } catch (err) {
    console.error("Google link failed:", err instanceof Error ? err.message : "unknown error");
    await outbox.sendText(chatId, "Akun Google gagal dihubungkan. Coba lagi dengan /google.").catch(() => {});
    return { ok: false, title: "Gagal menghubungkan", text: "Coba lagi dengan mengirim /google di WhatsApp." };
  }
}

/** Forgets the account and asks Google to end the access too. Also clears the chat history that may hold Google data. */
export async function disconnect(number: string, chatId: string): Promise<boolean> {
  const row = db.prepare("DELETE FROM google_accounts WHERE number = ? RETURNING refresh_token").get(number) as { refresh_token: string } | undefined;
  tokens.delete(number);
  if (!row) return false;
  db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM google_pending WHERE number = ?").run(number);
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: decrypt(row.refresh_token) }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => console.warn("Couldn't reach Google to revoke a token; it was forgotten here anyway."));
  return true;
}

// --- Calling Google ------------------------------------------------------------------------------------------------

const tokens = new Map<string, { value: string; expires: number }>();

async function accessToken(number: string, now = Date.now()): Promise<string> {
  const cached = tokens.get(number);
  if (cached && cached.expires > now + 60_000) return cached.value;
  const row = db.prepare("SELECT refresh_token FROM google_accounts WHERE number = ?").get(number) as { refresh_token: string } | undefined;
  if (!row) throw new Error("This person hasn't connected a Google account. Ask them to send /google.");
  try {
    const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token) });
    tokens.set(number, { value: token.access_token, expires: now + token.expires_in * 1000 });
    return token.access_token;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.message === "invalid_grant") {
      db.prepare("DELETE FROM google_accounts WHERE number = ?").run(number);
      throw new Error("Google ended this access (it was revoked or expired). Ask them to send /google to connect again.");
    }
    throw err;
  }
}

export type GoogleRequest = { method?: string; query?: Record<string, string | number | boolean | undefined>; json?: unknown; body?: Buffer | string; contentType?: string; text?: boolean };

/** One authenticated call as this person. Returns parsed JSON, or text with `text: true`. */
export async function google<T = any>(number: string, url: string, req: GoogleRequest = {}): Promise<T> {
  const query = Object.entries(req.query ?? {}).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  const target = query.length ? `${url}?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : url;
  const body = req.json === undefined ? (Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : req.body) : JSON.stringify(req.json);
  const contentType = req.json === undefined ? req.contentType : "application/json";
  const res = await fetch(target, {
    method: req.method ?? "GET",
    headers: { Authorization: `Bearer ${await accessToken(number)}`, ...(contentType && { "Content-Type": contentType }) },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google said: ${error.error?.message ?? `HTTP ${res.status}`}`);
  }
  if (req.text) return (await res.text()) as T;
  return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
}
