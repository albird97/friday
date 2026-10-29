import { Cron } from "croner";
import { config } from "./config.js";
import { db } from "./db.js";
import { formatDateTime } from "./time.js";
import type { Outbox } from "./types.js";

export type Reminder = {
  id: number;
  chat_id: string;
  created_by: string;
  text: string;
  due_at: number;
  cron: string | null;
};

/**
 * Next time a schedule fires after `after`. `schedule` is either a date-time ("2026-10-29T17:00",
 * read in the configured timezone unless it carries an offset) or a 5-field cron expression.
 * Throws on an invalid schedule; returns null when a one-off time is already in the past.
 */
export function nextRun(schedule: string, after = new Date()): Date | null {
  return new Cron(schedule, { timezone: config.TIMEZONE, paused: true }).nextRun(after);
}

export function createReminder(input: {
  chatId: string;
  createdBy: string;
  text: string;
  when?: string;
  cron?: string;
}): Reminder {
  const schedule = input.cron ?? input.when;
  if (!schedule) throw new Error("Give either `when` or `repeat_cron`.");
  const due = nextRun(schedule);
  if (!due) throw new Error(`${schedule} is in the past.`);
  const result = db
    .prepare(
      "INSERT INTO reminders (chat_id, created_by, text, due_at, cron, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(input.chatId, input.createdBy, input.text, due.getTime(), input.cron ?? null, Date.now());
  return {
    id: Number(result.lastInsertRowid),
    chat_id: input.chatId,
    created_by: input.createdBy,
    text: input.text,
    due_at: due.getTime(),
    cron: input.cron ?? null,
  };
}

/** Active reminders delivered to any of these chats, or created by `createdBy`. */
export function listReminders(chatIds: string[], createdBy: string): Reminder[] {
  const placeholders = chatIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, chat_id, created_by, text, due_at, cron FROM reminders
       WHERE active = 1 AND (chat_id IN (${placeholders}) OR created_by = ?) ORDER BY due_at`,
    )
    .all(...chatIds, createdBy) as Reminder[];
}

/** Cancels a reminder if it is delivered to one of `chatIds` or was created by `createdBy`. */
export function cancelReminder(id: number, chatIds: string[], createdBy: string): boolean {
  const placeholders = chatIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE reminders SET active = 0
       WHERE id = ? AND active = 1 AND (chat_id IN (${placeholders}) OR created_by = ?)`,
    )
    .run(id, ...chatIds, createdBy);
  return result.changes > 0;
}

export function describeReminder(r: Reminder): string {
  const when = formatDateTime(new Date(r.due_at));
  return r.cron ? `#${r.id} "${r.text}" — repeats (${r.cron}), next ${when}` : `#${r.id} "${r.text}" — ${when}`;
}

/** Terminal mode (`npm run chat`) delivers only its own reminders; WhatsApp mode delivers the rest. */
export const isTerminalChat = (chatId: string) => chatId === "cli" || chatId.startsWith("cli:");

/** Sends every due reminder for chats this process delivers to, then reschedules repeating ones. */
export async function fireDueReminders(outbox: Outbox, now = new Date(), delivers = (chatId: string) => !isTerminalChat(chatId)): Promise<void> {
  const due = (
    db
      .prepare("SELECT id, chat_id, created_by, text, due_at, cron FROM reminders WHERE active = 1 AND due_at <= ?")
      .all(now.getTime()) as Reminder[]
  ).filter((r) => delivers(r.chat_id));

  for (const r of due) {
    const lateBy = now.getTime() - r.due_at;
    let message = `⏰ *Reminder:* ${r.text}`;
    if (lateBy > 5 * 60_000) message += `\n_(was due ${formatDateTime(new Date(r.due_at))})_`;
    try {
      await outbox.sendText(r.chat_id, message);
    } catch (err) {
      console.error(`reminder #${r.id}: send failed, will retry`, err);
      continue;
    }
    const next = r.cron ? nextRun(r.cron, now) : null;
    if (next) db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(next.getTime(), r.id);
    else db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").run(r.id);
  }
}

export function startReminderLoop(outbox: Outbox, delivers?: (chatId: string) => boolean): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fireDueReminders(outbox, new Date(), delivers);
    } finally {
      running = false;
    }
  }, 15_000);
}
