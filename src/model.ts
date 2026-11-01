import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { db } from "./db.js";

// Which Claude model answers, in every chat. The admin picks a family with /switch; Friday always runs that family's
// newest version, looked up from the Models API. The choice is stored, so it outlives a restart.

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

export function currentModel(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'model'").get() as { value: string } | undefined;
  return row?.value ?? config.FRIDAY_MODEL;
}

export function setModel(model: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('model', ?)").run(model);
}

/** The newest model of a family that this API key can use. */
export async function latestModel(family: Family): Promise<string> {
  const ids: string[] = [];
  for await (const model of new Anthropic().models.list()) ids.push(model.id);
  const newest = newestOf(family, ids);
  if (!newest) throw new Error(`No ${family} model is available.`);
  return newest;
}
