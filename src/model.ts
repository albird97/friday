import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { db } from "./db.js";

// Which Claude model answers. /switch picks a family for one chat, or for every chat without its own choice; Friday
// always runs that family's newest version, looked up from the Models API. Choices are stored, so they outlive a restart.

export const FAMILIES = ["opus", "sonnet", "haiku"] as const;
export type Family = (typeof FAMILIES)[number];

const ID = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

export function isFamily(name: string): name is Family {
  return (FAMILIES as readonly string[]).includes(name);
}

export function familyOf(model: string): Family | undefined {
  return ID.exec(model)?.[1] as Family | undefined;
}

/** The highest version of a family among model ids: claude-opus-5-5 beats claude-opus-5 and claude-opus-4-5-20251101. */
export function newestOf(family: Family, ids: string[]): string | undefined {
  const version = (id: string) => {
    const m = ID.exec(id);
    return m?.[1] === family ? Number(m[2]) * 100 + Number(m[3] ?? 0) : -1;
  };
  const best = ids.reduce((a, b) => (version(b) > version(a) ? b : a), "");
  return version(best) >= 0 ? best : undefined;
}

/** The model answering in this chat, or without a chat the one used by every chat without its own choice. */
export function currentModel(chatId?: string): string {
  const own = chatId === undefined ? undefined : chatModel(chatId);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'model'").get() as { value: string } | undefined;
  return own ?? row?.value ?? config.FRIDAY_MODEL;
}

export function setModel(model: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('model', ?)").run(model);
}

const chatKey = (chatId: string) => `model:${chatId}`;

/** The model a chat chose for itself, if it did. */
export function chatModel(chatId: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(chatKey(chatId)) as { value: string } | undefined)?.value;
}

/** Without a model, the chat goes back to the one every chat uses. */
export function setChatModel(chatId: string, model: string | undefined): void {
  if (model) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(chatKey(chatId), model);
  else db.prepare("DELETE FROM settings WHERE key = ?").run(chatKey(chatId));
}

export function chatModels(): { chatId: string; model: string }[] {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'model:%'").all() as { key: string; value: string }[];
  return rows.map((r) => ({ chatId: r.key.slice(chatKey("").length), model: r.value }));
}

/** The newest model of a family that this API key can use. */
export async function latestModel(family: Family): Promise<string> {
  const ids: string[] = [];
  for await (const model of new Anthropic().models.list()) ids.push(model.id);
  const newest = newestOf(family, ids);
  if (!newest) throw new Error(`No ${family} model is available.`);
  return newest;
}
