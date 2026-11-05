import { db } from "./db.js";
import { problemText } from "./logging.js";
import { localDay } from "./time.js";

// What the dashboard (/admin) knows about Friday's health, recorded as it happens: the WhatsApp connection (in memory),
// every answered message and every tool call (in the database). Only when, where, who, how long and how it ended:
// never what anyone wrote.

export const startedAt = Date.now();

export type WhatsAppState = "connecting" | "waitingForScan" | "open" | "closed" | "loggedOut";
/** detail: the disconnect status code for "closed" (e.g. "428"), the bot's number for "open". */
export type ConnectionEvent = { at: number; state: WhatsAppState; detail?: string };
export type WhatsAppStatus = { state: WhatsAppState; since: number; number?: string; reconnects: number };

const MAX_EVENTS = 50;
const whatsapp: WhatsAppStatus = { state: "connecting", since: startedAt, reconnects: 0 };
const events: ConnectionEvent[] = [];

/** Called by the WhatsApp connection whenever its state changes. */
export function noteWhatsApp(state: WhatsAppState, detail?: string): void {
  const now = Date.now();
  if (state === "open") {
    if (whatsapp.number !== undefined || events.some((e) => e.state === "open")) whatsapp.reconnects++;
    whatsapp.number = detail;
  }
  if (state !== whatsapp.state) {
    whatsapp.state = state;
    whatsapp.since = now;
  }
  const last = events.at(-1);
  if (last?.state === state && last.detail === detail) return;
  events.push({ at: now, state, ...(detail !== undefined && { detail }) });
  if (events.length > MAX_EVENTS) events.shift();
}

export function whatsappStatus(): WhatsAppStatus {
  return { ...whatsapp };
}

/** Newest first. */
export function connectionEvents(): ConnectionEvent[] {
  return [...events].reverse();
}

export type Outcome = "ok" | "refused" | "failed";
export type TurnRecord = { at: number; chatId: string; chatName: string; number: string; name: string; ms: number; outcome: Outcome };

let lastFailure: { at: number; message: string } | undefined;

/** The last Claude turn that failed (API error, timeout…), since Friday started. */
export function lastTurnFailure(): { at: number; message: string } | undefined {
  return lastFailure && { ...lastFailure };
}

/** Records one answered message. Never throws: a dashboard figure must not cost anyone their reply. */
export function recordTurn(turn: TurnRecord, error?: unknown): void {
  if (turn.outcome === "failed") lastFailure = { at: turn.at + turn.ms, message: problemText([error ?? "unknown error"]) };
  try {
    db.prepare("INSERT INTO turns (at, day, chat_id, chat_name, number, name, ms, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      turn.at,
      localDay(new Date(turn.at)),
      turn.chatId,
      turn.chatName,
      turn.number,
      turn.name,
      Math.max(0, Math.round(turn.ms)),
      turn.outcome,
    );
  } catch (err) {
    console.warn("Couldn't record a turn for the dashboard:", err instanceof Error ? err.message : err);
  }
}

/** Counts one tool call for today. Never throws. */
export function recordTool(tool: string, ok: boolean, ms: number, at = new Date()): void {
  try {
    db.prepare(
      `INSERT INTO tool_usage (day, tool, calls, errors, total_ms) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (day, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, total_ms = total_ms + excluded.total_ms`,
    ).run(localDay(at), tool, ok ? 0 : 1, Math.max(0, Math.round(ms)));
  } catch (err) {
    console.warn("Couldn't record a tool call for the dashboard:", err instanceof Error ? err.message : err);
  }
}

const TURNS_KEPT_DAYS = 180;
const TOOLS_KEPT_DAYS = 400;
const LOGINS_KEPT = 500;

/** Drops old dashboard records and expired sign-ins. Run at startup and daily. */
export function pruneMonitor(now = Date.now()): void {
  db.prepare("DELETE FROM turns WHERE at < ?").run(now - TURNS_KEPT_DAYS * 86_400_000);
  db.prepare("DELETE FROM tool_usage WHERE day < ?").run(localDay(new Date(now - TOOLS_KEPT_DAYS * 86_400_000)));
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM admin_logins WHERE id NOT IN (SELECT id FROM admin_logins ORDER BY id DESC LIMIT ?)").run(LOGINS_KEPT);
}
