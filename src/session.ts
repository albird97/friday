import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { config } from "./config.js";
import { db } from "./db.js";

/**
 * One conversation with Claude. The history is append-only while the session lives (Claude's thinking
 * blocks are only valid against an unchanged history), so instead of trimming old turns we start a
 * fresh session — with a short text recap of the last one — after a quiet spell or once it gets big.
 */
export type Session = {
  system: string;
  messages: BetaMessageParam[];
  tokens: number; // context size of the last request
  updatedAt: number;
};

type Row = { system: string; messages: string; tokens: number; updated_at: number };

export function loadSession(chatId: string): Session | undefined {
  const row = db.prepare("SELECT system, messages, tokens, updated_at FROM sessions WHERE chat_id = ?").get(chatId) as Row | undefined;
  return row && { system: row.system, messages: JSON.parse(row.messages), tokens: row.tokens, updatedAt: row.updated_at };
}

export function saveSession(chatId: string, s: Session): void {
  db.prepare(
    `INSERT INTO sessions (chat_id, system, messages, tokens, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id) DO UPDATE SET system = excluded.system, messages = excluded.messages,
       tokens = excluded.tokens, updated_at = excluded.updated_at`,
  ).run(chatId, s.system, JSON.stringify(s.messages), s.tokens, s.updatedAt);
}

export function deleteSession(chatId: string): void {
  db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
}

/** Makes the next message start a new session (with a recap of this one), e.g. so a changed system prompt applies. */
export function expireSession(chatId: string): void {
  db.prepare("UPDATE sessions SET updated_at = 0 WHERE chat_id = ?").run(chatId);
}

export function isStale(s: Session, now = Date.now()): boolean {
  return now - s.updatedAt > config.SESSION_IDLE_HOURS * 3_600_000 || s.tokens > config.SESSION_MAX_TOKENS;
}

/** The visible text of the last few exchanges, for carrying context into a new session. */
export function recapOf(messages: BetaMessageParam[], maxEntries = 12, maxChars = 500): string {
  const lines: string[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : (m.content ?? []);
    const text = blocks
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    if (!text) continue;
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    lines.push(m.role === "user" ? clipped : `${config.BOT_NAME}: ${clipped}`);
  }
  return lines.slice(-maxEntries).join("\n");
}
