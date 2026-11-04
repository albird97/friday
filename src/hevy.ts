import { config } from "./config.js";
import { db } from "./db.js";
import { decrypt, encrypt } from "./google.js";
import { expireSession } from "./session.js";
import type { ChatContext } from "./types.js";

// Each contact links their own Hevy account (it needs Hevy Pro) with the personal API key from hevy.com/settings?developer.
// The key arrives in a /hevy message that bot.ts handles without Claude, so it never enters a conversation. It is kept
// encrypted with GOOGLE_TOKEN_KEY, and the account is always found from the sender's number, never from tool input.

const API = "https://api.hevyapp.com/v1";
export const KEY_PAGE = "https://hevy.com/settings?developer";
const CATALOG_MINUTES = 30;

export const hevyEnabled = /^[0-9a-f]{64}$/i.test(config.GOOGLE_TOKEN_KEY);

/** Hevy never reaches groups: other people read every reply there. */
export function hevyAllowed(chat: ChatContext): boolean {
  return hevyEnabled && !chat.isGroup && chat.sender.isContact;
}

export type HevyAccount = { number: string; name: string };

export function hevyAccount(number: string): HevyAccount | undefined {
  return db.prepare("SELECT number, name FROM hevy_accounts WHERE number = ?").get(number) as HevyAccount | undefined;
}

/** What `/hevy <key>` accepts. Hevy's keys are UUIDs; this is a little looser in case that changes. */
export const isKeyShaped = (text: string) => /^[A-Za-z0-9-]{16,100}$/.test(text);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HevyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// --- Calling Hevy --------------------------------------------------------------------------------------------------

export type HevyRequest = { method?: "GET" | "POST" | "PUT"; query?: Record<string, string | number | undefined>; json?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(res: Response): Promise<HevyError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  const said = String(body.error ?? body.message ?? "").slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    return new HevyError(`Hevy rejected the API key (it was changed or revoked, or Hevy Pro ended). Ask them to send /hevy with a new key from ${KEY_PAGE}.`, res.status);
  }
  if (res.status === 404) return new HevyError(`Hevy couldn't find that${said ? ` (${said})` : ""}.`, 404);
  if (res.status === 429) return new HevyError("Hevy is limiting requests right now. Try again in a minute.", 429);
  return new HevyError(`Hevy said: ${said || `HTTP ${res.status}`}`, res.status);
}

/** One call with a given key. Reads and edits are retried on a hiccup; creating isn't, as a retry could save it twice. */
async function call<T>(apiKey: string, path: string, req: HevyRequest = {}): Promise<T> {
  const method = req.method ?? "GET";
  const query = Object.entries(req.query ?? {}).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  const url = `${API}${path}${query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : ""}`;
  const attempts = method === "POST" ? 1 : 3;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { "api-key": apiKey, Accept: "application/json", ...(req.json !== undefined && { "Content-Type": "application/json" }) },
        body: req.json === undefined ? undefined : JSON.stringify(req.json),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt < attempts) {
        await sleep(attempt * 1000);
        continue;
      }
      throw new HevyError(
        method === "POST" ? "Lost the connection to Hevy, so it may or may not have saved. Check the Hevy app before trying again." : "Couldn't reach Hevy right now. Try again in a minute.",
      );
    }
    if (res.ok) return (await res.json().catch(() => undefined)) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const wait = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 10) * 1000 : attempt * 1000);
      continue;
    }
    throw await failure(res);
  }
}

/** One call as this person. */
export async function hevy<T = any>(number: string, path: string, req?: HevyRequest): Promise<T> {
  const row = db.prepare("SELECT api_key FROM hevy_accounts WHERE number = ?").get(number) as { api_key: string } | undefined;
  if (!row) throw new HevyError("This person hasn't connected Hevy. Ask them to send /hevy in this private chat.");
  return call<T>(decrypt(row.api_key), path, req);
}

/** Hevy wraps some answers ({ workout: … }, sometimes in a one-item list) and not others; this takes either. */
export function unwrap<T>(body: unknown, key: string): T | undefined {
  const inner = body && typeof body === "object" && key in body ? (body as Record<string, unknown>)[key] : body;
  return (Array.isArray(inner) ? inner[0] : inner) as T | undefined;
}

// --- Linking an account --------------------------------------------------------------------------------------------

/** What someone reads before they paste a key. */
export function connectMessage(adminName: string): string {
  const bot = config.BOT_NAME;
  return [
    "🏋️ *Hubungkan Hevy*",
    `${bot} bisa mencatat workout (juga dari foto catatan latihan atau voice note), membuat latihan dan rutinitas baru, mencatat berat badan, dan membaca progresmu di Hevy, hanya di chat pribadi ini.`,
    ["*Caranya:*", `1. Buka ${KEY_PAGE} (perlu Hevy Pro) lalu salin API key-nya.`, "2. Kirim ke sini: /hevy <api key>"].join("\n"),
    [
      "*Perlu kamu tahu:*",
      `- Data Hevy yang dibaca ${bot} dikirim ke Claude (Anthropic) untuk diproses, dan tersimpan sementara di riwayat chat di server yang dikelola ${adminName}.`,
      "- API key disimpan terenkripsi dan tidak pernah dikirim ke Claude.",
      `- Yang kamu minta langsung disimpan, dan ${bot} selalu mengirim ringkasan persis apa yang tersimpan.`,
      "- Putuskan kapan saja dengan /hevy putus.",
    ].join("\n"),
    `Kebijakan privasi: ${config.PUBLIC_URL}/privacy`,
  ].join("\n\n");
}

/**
 * True when a private message is nothing but a Hevy-style key (a UUID), whenever it's sent. It's handled like
 * `/hevy <key>`, so a key pasted on its own never reaches Claude; such a message means little else.
 */
export function isBareKey(chat: ChatContext, text: string): boolean {
  return hevyAllowed(chat) && UUID.test(text.trim());
}

/** Checks a key with Hevy and keeps it. Returns the Hevy profile name; throws HevyError when Hevy says no. */
export async function connectHevy(number: string, chatId: string, apiKey: string): Promise<string> {
  const info = await call<{ data?: { name?: string } }>(apiKey, "/user/info");
  const name = info?.data?.name?.trim() || "akun Hevy";
  db.prepare("INSERT OR REPLACE INTO hevy_accounts (number, name, api_key, connected_at) VALUES (?, ?, ?, ?)").run(number, name, encrypt(apiKey), Date.now());
  catalogs.delete(number);
  expireSession(chatId); // tools and the system prompt are fixed for a session
  return name;
}

/** Forgets the key and the chat history that may hold Hevy data. Hevy has no way to revoke a key from here. */
export function disconnectHevy(number: string, chatId: string): boolean {
  catalogs.delete(number);
  const gone = db.prepare("DELETE FROM hevy_accounts WHERE number = ?").run(number).changes > 0;
  if (!gone) return false;
  db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM hevy_privacy WHERE number = ?").run(number);
  return true;
}

// --- Exercises -----------------------------------------------------------------------------------------------------

export type Template = { id: string; title: string; type?: string; primary_muscle_group?: string; secondary_muscle_groups?: string[]; is_custom?: boolean };

const catalogs = new Map<string, { at: number; templates: Template[] }>();

/** Every exercise this person can use in Hevy (built-in and their custom ones), kept for half an hour. */
export async function exerciseCatalog(number: string, refresh = false): Promise<Template[]> {
  const cached = catalogs.get(number);
  if (!refresh && cached && Date.now() - cached.at < CATALOG_MINUTES * 60_000) return cached.templates;
  const templates: Template[] = [];
  for (let page = 1; page <= 30; page++) {
    let body: { page_count?: number; exercise_templates?: Template[] } | undefined;
    try {
      body = await hevy(number, "/exercise_templates", { query: { page, pageSize: 100 } });
    } catch (err) {
      if (err instanceof HevyError && err.status === 404 && page > 1) break; // Hevy answers 404 past the last page
      throw err;
    }
    const items = body?.exercise_templates ?? [];
    templates.push(...items.filter((t) => t?.id && t.title));
    if (items.length === 0 || (body?.page_count !== undefined ? page >= body.page_count : items.length < 100)) break;
  }
  catalogs.set(number, { at: Date.now(), templates });
  return templates;
}

export const forgetCatalog = (number: string) => catalogs.delete(number);

// Gym shorthand and spelling, so "db incline press" or "lat pull down" still find Hevy's titles.
const ALIASES: [RegExp, string][] = [
  [/\bdb\b|\bdumbell\b/g, "dumbbell"],
  [/\bbb\b/g, "barbell"],
  [/\bkb\b/g, "kettlebell"],
  [/\bsm\b|\bsmith machine\b/g, "smith"],
  [/\bohp\b/g, "overhead press"],
  [/\brdl\b/g, "romanian deadlift"],
  [/\bsldl\b/g, "stiff leg deadlift"],
  [/\bbss\b/g, "bulgarian split squat"],
  [/\bpull ?down\b/g, "pulldown"],
  [/\bpush ?down\b/g, "pushdown"],
  [/\bpushups?\b/g, "push up"],
  [/\bpullups?\b/g, "pull up"],
  [/\bchinups?\b/g, "chin up"],
  [/\bsitups?\b/g, "sit up"],
  [/\bskullcrushers?\b/g, "skull crusher"],
  [/\bbicep\b/g, "biceps"],
  [/\btricep\b/g, "triceps"],
];

export function normalizeTitle(text: string): string {
  let value = ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ")} `;
  for (const [pattern, replacement] of ALIASES) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}

// Plurals count as the same word ("curls", "curl"), but not words that end in a double s ("press").
const words = (text: string) => normalizeTitle(text).split(" ").filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));

/** How well an exercise title answers a name someone used: 1 is the same name, 0 shares nothing. */
export function matchScore(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qw = new Set(words(query));
  const tw = new Set(words(title));
  const common = [...qw].filter((w) => tw.has(w)).length;
  if (common === 0) return 0;
  const score = 0.6 * (common / qw.size) + 0.35 * (common / tw.size) + (t.includes(q) ? 0.04 : 0);
  return Math.min(0.99, score);
}

/** The best candidates for a name, best first. */
export function findExercises(templates: Template[], query: string, muscle?: string, limit = 5): { template: Template; score: number }[] {
  return templates
    .filter((t) => !muscle || t.primary_muscle_group === muscle)
    .map((template) => ({ template, score: matchScore(query, template.title) }))
    .filter((m) => m.score > 0.2)
    .sort((a, b) => b.score - a.score || a.template.title.length - b.template.title.length)
    .slice(0, limit);
}
