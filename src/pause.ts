import { db } from "./db.js";
import { formatDateTime } from "./time.js";

// The admin can silence Friday in one group for a while (/diam) or everywhere until further notice (/stop). Kept in
// the database so a restart doesn't undo it. While paused Friday ignores messages (and errand replies); the admin's
// commands still work, and reminders still fire.

export const EVERYWHERE = "*";
const MAX_MS = 7 * 24 * 3600_000;

export type Pause = { chatId: string; chatName: string; until: number | null };

export function pause(chatId: string, chatName: string, until: number | null): void {
  db.prepare("INSERT OR REPLACE INTO pauses (chat_id, chat_name, until) VALUES (?, ?, ?)").run(chatId, chatName, until);
}

/** Returns whether it was paused. */
export function resume(chatId: string): boolean {
  return db.prepare("DELETE FROM pauses WHERE chat_id = ?").run(chatId).changes > 0;
}

/** Pauses still in effect; expired ones are cleared. */
export function activePauses(now = Date.now()): Pause[] {
  db.prepare("DELETE FROM pauses WHERE until IS NOT NULL AND until <= ?").run(now);
  return db.prepare("SELECT chat_id AS chatId, chat_name AS chatName, until FROM pauses ORDER BY chat_id").all() as Pause[];
}

/** Whether Friday should stay quiet in this chat: paused everywhere, or in this chat. */
export function isPaused(chatId: string, now = Date.now()): boolean {
  return activePauses(now).some((p) => p.chatId === EVERYWHERE || p.chatId === chatId);
}

/** "30m", "2j", "1 jam", "3h" (hari), "1d" → milliseconds, at most 7 days; empty → 1 hour; undefined if unreadable. */
export function parseDuration(text: string): number | undefined {
  const raw = text.trim().toLowerCase();
  if (!raw) return 3600_000;
  const match = /^(\d+(?:[.,]\d+)?)\s*(m|mnt|menit|min|j|jam|h|hari|d|day|days)$/.exec(raw);
  if (!match) return undefined;
  const amount = Number(match[1].replace(",", "."));
  const unit = match[2];
  const ms = amount * (/^m/.test(unit) ? 60_000 : /^(j|jam)$/.test(unit) ? 3600_000 : 24 * 3600_000);
  return ms > 0 ? Math.min(ms, MAX_MS) : undefined;
}

export function describePause(p: Pause): string {
  const where = p.chatId === EVERYWHERE ? "Semua chat" : p.chatName;
  return `${where}: ${p.until === null ? "sampai dinyalakan lagi" : `sampai ${formatDateTime(new Date(p.until))}`}`;
}
