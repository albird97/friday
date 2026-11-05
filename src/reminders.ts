import { Cron } from "croner";
import { config } from "./config.js";
import { db } from "./db.js";
import { formatDateTime } from "./time.js";
import type { Outbox } from "./types.js";

/**
 * What happens when a schedule comes due: "reminder" sends its text with a ⏰ label, "message" sends it exactly as
 * written (greetings, announcements), and "task" hands it to Friday as an instruction to carry out in that chat then
 * (a poll, today's news…), which costs a Claude turn each time.
 */
export type Kind = "reminder" | "message" | "task";

export type Reminder = {
  id: number;
  chat_id: string;
  created_by: string;
  text: string;
  due_at: number;
  cron: string | null;
  kind: Kind;
  /** The group's name for schedules set up for a group from elsewhere; otherwise null. */
  chat_name: string | null;
  /** For a task: what Friday sent the last time it ran ("" for nothing), so it can skip repeating itself. */
  last_said: string | null;
};

const COLUMNS = "id, chat_id, created_by, text, due_at, cron, kind, chat_name, last_said";

/** Each task run costs a Claude turn, so a person keeps a handful at most, repeating at most hourly. */
export const MAX_TASKS = 10;
const MIN_TASK_GAP_MS = 3600_000;
const MAX_LATE_MS = 3600_000;

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
  kind?: Kind;
  chatName?: string;
}): Reminder {
  const kind = input.kind ?? "reminder";
  const schedule = input.cron ?? input.when;
  if (!schedule) throw new Error("Give either `when` or `repeat_cron`.");
  const due = nextRun(schedule);
  if (!due) throw new Error(`${schedule} is in the past.`);
  if (kind === "task") {
    if (input.cron) {
      const runs = new Cron(input.cron, { timezone: config.TIMEZONE, paused: true }).nextRuns(24);
      if (runs.some((run, i) => i > 0 && run.getTime() - runs[i - 1].getTime() < MIN_TASK_GAP_MS)) {
        throw new Error("Scheduled tasks repeat at most once an hour.");
      }
    }
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM reminders WHERE active = 1 AND kind = 'task' AND created_by = ?")
      .get(input.createdBy) as { count: number };
    if (count >= MAX_TASKS) throw new Error(`They already have ${MAX_TASKS} scheduled tasks; cancel one first.`);
  }
  const result = db
    .prepare(
      "INSERT INTO reminders (chat_id, created_by, text, due_at, cron, kind, chat_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.chatId, input.createdBy, input.text, due.getTime(), input.cron ?? null, kind, input.chatName ?? null, Date.now());
  return {
    id: Number(result.lastInsertRowid),
    chat_id: input.chatId,
    created_by: input.createdBy,
    text: input.text,
    due_at: due.getTime(),
    cron: input.cron ?? null,
    kind,
    chat_name: input.chatName ?? null,
    last_said: null,
  };
}

/** Active reminders delivered to any of these chats, or created by `createdBy`. */
export function listReminders(chatIds: string[], createdBy: string): Reminder[] {
  const placeholders = chatIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders
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
  const what = r.kind === "task" ? `task "${r.text}"` : r.kind === "message" ? `message "${r.text}"` : `"${r.text}"`;
  const where = r.chat_name ? ` in ${r.chat_name}` : "";
  return r.cron ? `#${r.id} ${what}${where} — repeats (${r.cron}), next ${when}` : `#${r.id} ${what}${where} — ${when}`;
}

/** Terminal mode (`npm run chat`) delivers only its own reminders; WhatsApp mode delivers the rest. */
export const isTerminalChat = (chatId: string) => chatId === "cli" || chatId.startsWith("cli:");

/** Runs a due task; resolves once Friday has answered it. */
export type TaskRunner = (task: Reminder) => Promise<void>;

/** Sends every due reminder for chats this process delivers to, then reschedules repeating ones. */
export async function fireDueReminders(
  outbox: Outbox,
  now = new Date(),
  delivers = (chatId: string) => !isTerminalChat(chatId),
  runTask?: TaskRunner,
): Promise<void> {
  const due = (
    db.prepare(`SELECT ${COLUMNS} FROM reminders WHERE active = 1 AND due_at <= ?`).all(now.getTime()) as Reminder[]
  ).filter((r) => delivers(r.chat_id));

  for (const r of due) {
    const reschedule = () => {
      const next = r.cron ? nextRun(r.cron, now) : null;
      if (next) db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(next.getTime(), r.id);
      else db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").run(r.id);
    };
    const lateBy = now.getTime() - r.due_at;
    // A good-morning message or a poll is out of place hours later (Friday was down): skip that run, keep the schedule.
    if (r.kind !== "reminder" && lateBy > MAX_LATE_MS) {
      console.warn(`${r.kind} #${r.id}: skipped a run that was ${Math.round(lateBy / 60_000)} minutes late`);
      reschedule();
      continue;
    }
    if (r.kind === "task") {
      // Rescheduled first: a task runs once even if Friday's answer fails or takes longer than the loop's tick.
      reschedule();
      if (runTask) void runTask(r).catch((err) => console.error(`task #${r.id} failed`, err));
      continue;
    }
    let message = r.kind === "message" ? r.text : `⏰ *Reminder:* ${r.text}`;
    if (lateBy > 5 * 60_000 && r.kind === "reminder") message += `\n_(was due ${formatDateTime(new Date(r.due_at))})_`;
    try {
      await outbox.sendText(r.chat_id, message);
    } catch (err) {
      console.error(`reminder #${r.id}: send failed, will retry`, err);
      continue;
    }
    reschedule();
  }
}

export function startReminderLoop(outbox: Outbox, delivers?: (chatId: string) => boolean, runTask?: TaskRunner): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fireDueReminders(outbox, new Date(), delivers, runTask);
    } finally {
      running = false;
    }
  }, 15_000);
}
