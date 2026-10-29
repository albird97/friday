import { randomInt } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import pg from "pg";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import type { ChatContext, Outbox } from "./types.js";

// onehub is the family business's back office. Friday can read its database through a read-only role, and run a
// few actions through onehub's own internal API — but an action only runs after the person confirms onehub's preview
// by replying with a one-time code, which this file checks (not Claude). Only the numbers in ONEHUB_USERS get any of
// this, and only in private chats: in groups other people's messages are in the conversation and every reply is public.

export const onehubEnabled = config.onehubUsers.length > 0 && Boolean(config.ONEHUB_DATABASE_URL || config.ONEHUB_API_URL);

export function onehubAllowed(chat: ChatContext): boolean {
  return onehubEnabled && !chat.isGroup && config.onehubUsers.includes(chat.sender.number);
}

// --- Reading -------------------------------------------------------------------------------------------------------

const MAX_ROWS = 200;
const MAX_CHARS = 30_000;
const BLOCKED_FUNCTIONS = /\b(set_config|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_read_\w+|lo_\w+|dblink\w*)\s*\(/i;
// Dates and times come back as the database's own text, so nothing shifts with the server's timezone.
const RAW_TYPES = new Set([1082, 1083, 1114, 1184, 1266]); // date, time, timestamp, timestamptz, timetz
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    RAW_TYPES.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

let pool: pg.Pool | undefined;

/** Accepts one SELECT (or WITH … SELECT) statement. The database role can only read anyway; this keeps queries tame. */
export function checkQuery(sql: string): string {
  const query = sql.trim().replace(/;\s*$/, "");
  if (query.includes(";")) throw new Error("Send one statement at a time (no semicolons).");
  if (!/^(select|with)\b/i.test(query)) throw new Error("Only SELECT queries are allowed.");
  if (BLOCKED_FUNCTIONS.test(query)) throw new Error("That function isn't allowed.");
  return query;
}

async function select(query: string, params: unknown[] = []): Promise<pg.QueryArrayResult> {
  if (!config.ONEHUB_DATABASE_URL) throw new Error("onehub's database isn't connected. (Admin: set ONEHUB_DATABASE_URL.)");
  pool ??= new pg.Pool({ connectionString: config.ONEHUB_DATABASE_URL, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', '8s', true), set_config('timezone', $1, true)", [config.TIMEZONE]);
    return await client.query({ text: query, values: params, rowMode: "array", types });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/** Rows as "a | b | c" lines under a header, capped so one query can't flood the conversation. */
export function formatRows(fields: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "No rows.";
  const lines = [fields.join(" | "), ...rows.slice(0, MAX_ROWS).map((row) => row.map(cellText).join(" | "))];
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(cut off)`;
  const more = rows.length > MAX_ROWS ? ` (showing the first ${MAX_ROWS}; aggregate or filter for the rest)` : "";
  return `${rows.length} row${rows.length === 1 ? "" : "s"}${more}\n${text}`;
}

async function schema(tables: string[] | undefined): Promise<string> {
  // information_schema only lists the columns this role may read, so hidden tables and columns never appear.
  const result = await select(
    `SELECT table_name, string_agg(column_name || ' ' || udt_name, ', ' ORDER BY ordinal_position)
       FROM information_schema.columns
      WHERE table_schema = 'public' AND ($1::text[] IS NULL OR table_name = ANY($1))
      GROUP BY table_name ORDER BY table_name`,
    [tables?.length ? tables : null],
  );
  if (tables?.length) return result.rows.map(([table, columns]) => `${table}: ${columns}`).join("\n") || "None of those tables are readable.";

  const guide = config.ONEHUB_API_URL ? await api<{ guide: string }>("GET", "/guide").then((g) => g.guide, () => "") : "";
  const names = result.rows.map(([table]) => table).join(", ");
  return `${guide ? `${guide}\n\n` : ""}Readable tables: ${names}\n\nAsk for specific tables to see their columns.`;
}

// --- Actions -------------------------------------------------------------------------------------------------------

type ActionInfo = { name: string; description: string; input_schema: { type: "object"; [key: string]: unknown } };
type Pending = { id: number; action: string; params: string; token: string | null; status: string; created_at: number };

const CONFIRM_MINUTES = 10;
const CONFIRM = /^\s*(?:ya|yes)\s+(\d{4})\s*[.!]?\s*$/i;

let actions: { list: ActionInfo[]; at: number } | undefined;

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!config.ONEHUB_API_URL) throw new Error("onehub's actions aren't connected. (Admin: set ONEHUB_API_URL.)");
  const res = await fetch(`${config.ONEHUB_API_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.ONEHUB_API_TOKEN}`,
      accept: "application/json",
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => undefined)) as { error?: string; message?: string } | undefined;
  if (!res.ok) throw new Error(json?.error ?? json?.message ?? `onehub answered HTTP ${res.status}.`);
  return json as T;
}

/** onehub's action list, refreshed every 10 minutes. An unreachable onehub just means no action tools for now. */
async function actionList(): Promise<ActionInfo[]> {
  if (!config.ONEHUB_API_URL) return [];
  if (actions && Date.now() - actions.at < 10 * 60_000) return actions.list;
  try {
    actions = { list: (await api<{ actions: ActionInfo[] }>("GET", "/actions")).actions, at: Date.now() };
  } catch (err) {
    console.error("Couldn't load onehub's actions:", err instanceof Error ? err.message : err);
    actions = { list: actions?.list ?? [], at: Date.now() - 9 * 60_000 }; // try again in a minute
  }
  return actions.list;
}

async function proposeAction(action: ActionInfo, params: unknown, chat: ChatContext, outbox: Outbox): Promise<string> {
  const requestedBy = { name: chat.sender.name, number: chat.sender.number };
  const preview = await api<{ summary: string; token?: string }>("POST", `/actions/${action.name}/preview`, { params, requested_by: requestedBy });
  const code = String(randomInt(1000, 10_000));
  db.prepare(
    "INSERT INTO pending_actions (chat_id, number, code, action, params, token, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(chat.chatId, chat.sender.number, code, action.name, JSON.stringify(params), preview.token ?? null, preview.summary, Date.now());
  // Sent by code, not by Claude, so what the person confirms is exactly what onehub will do.
  await outbox.sendText(
    chat.chatId,
    `⚠️ *Konfirmasi onehub*\n${preview.summary}\n\nBalas *YA ${code}* dalam ${CONFIRM_MINUTES} menit untuk menjalankan. Abaikan pesan ini untuk membatalkan.`,
  );
  return (
    "onehub's preview was sent to the person with a one-time confirmation code. Nothing has changed yet. Don't repeat " +
    "the preview or the code, and don't say it's done: it only runs if they reply with the code, and they'll see the result."
  );
}

/**
 * Handles "YA 1234" replies to a pending action. Returns true when the message was a confirmation (handled here,
 * never shown to Claude), false for everything else.
 */
export async function confirmAction(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  const match = onehubAllowed(chat) ? CONFIRM.exec(text) : null;
  if (!match) return false;
  const reply = (message: string) => outbox.sendText(chat.chatId, message);

  const pending = db
    .prepare("SELECT id, action, params, token, status, created_at FROM pending_actions WHERE chat_id = ? AND number = ? AND code = ? ORDER BY id DESC LIMIT 1")
    .get(chat.chatId, chat.sender.number, match[1]) as Pending | undefined;
  if (!pending || pending.status !== "pending") {
    const waiting = db
      .prepare("SELECT 1 FROM pending_actions WHERE chat_id = ? AND status = 'pending' AND created_at > ?")
      .get(chat.chatId, Date.now() - CONFIRM_MINUTES * 60_000);
    if (!waiting) return false; // nothing awaits a code, so it's an ordinary message ("yes 2026")
    await reply("Kode itu tidak cocok dengan aksi onehub yang menunggu konfirmasi.");
    return true;
  }
  const finish = (status: string, result: string) =>
    db.prepare("UPDATE pending_actions SET status = ?, result = ? WHERE id = ?").run(status, result, pending.id);
  if (Date.now() - pending.created_at > CONFIRM_MINUTES * 60_000) {
    finish("expired", "The confirmation code expired before it was used.");
    await reply("Kode konfirmasi itu sudah kedaluwarsa. Minta ulang aksinya ke saya kalau masih perlu.");
    return true;
  }

  finish("running", "");
  try {
    const result = await api<{ message: string }>("POST", `/actions/${pending.action}/execute`, {
      params: JSON.parse(pending.params),
      token: pending.token,
      requested_by: { name: chat.sender.name, number: chat.sender.number },
    });
    finish("done", result.message);
    await reply(`✅ ${result.message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("failed", message);
    await reply(`❌ onehub tidak menjalankan aksi itu: ${message}`);
  }
  return true;
}

/** What happened to actions Claude proposed in this chat since its last turn, so it knows on the next message. */
export function actionNotes(chat: ChatContext): string | undefined {
  const rows = db
    .prepare("SELECT id, action, summary, status, result FROM pending_actions WHERE chat_id = ? AND noted = 0 AND status NOT IN ('pending', 'running')")
    .all(chat.chatId) as { id: number; action: string; summary: string; status: string; result: string }[];
  if (rows.length === 0) return undefined;
  db.prepare(`UPDATE pending_actions SET noted = 1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  const lines = rows.map((r) => `- ${r.action} ("${r.summary.split("\n")[0]}"): ${r.status}${r.result ? ` — ${r.result}` : ""}`);
  return `[System note — onehub actions you proposed earlier:\n${lines.join("\n")}]`;
}

// --- Tools ---------------------------------------------------------------------------------------------------------

const QueryInput = z.object({
  sql: z.string().min(1).describe("One PostgreSQL SELECT statement (WITH … SELECT is fine)."),
});
const SchemaInput = z.object({
  tables: z.array(z.string()).optional().describe("Tables to show columns for. Omit to get the guide and the table list."),
});

const READ_TOOLS = [
  {
    name: "onehub_schema",
    description:
      "Learn onehub's database before querying it. Without `tables`: a short guide to the business data and the list of " +
      "readable tables. With `tables`: their columns and types. Call it before your first onehub_query in a conversation.",
    schema: SchemaInput,
  },
  {
    name: "onehub_query",
    description:
      "Run a read-only SQL query on onehub's PostgreSQL database and get the rows back (max 200 rows, 8 seconds). " +
      "Prefer aggregates (SUM, COUNT, GROUP BY) and date filters over pulling raw rows. Times are local (Asia/Jakarta).",
    schema: QueryInput,
  },
];

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/** onehub's tools for this chat (none unless onehubAllowed). They come after the shared, cached tool definitions. */
export async function onehubTools(chat: ChatContext): Promise<BetaToolUnion[]> {
  if (!onehubAllowed(chat)) return [];
  const read = config.ONEHUB_DATABASE_URL
    ? READ_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }))
    : [];
  const act = (await actionList()).map((a) => ({
    name: `onehub_${a.name}`,
    description: `${a.description}\n\nThis only proposes the action: onehub sends a preview and the person must confirm it with a code before anything changes.`,
    input_schema: a.input_schema,
  }));
  return [...read, ...act];
}

/** Runs an onehub_* tool. Returns undefined if `name` isn't one. */
export async function runOnehubTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("onehub_")) return undefined;
  if (!onehubAllowed(chat)) throw new Error("onehub isn't available in this chat.");
  if (name === "onehub_query") return formatRowsOf(await select(checkQuery(QueryInput.parse(input).sql)));
  if (name === "onehub_schema") return schema(SchemaInput.parse(input).tables);
  const action = (await actionList()).find((a) => `onehub_${a.name}` === name);
  if (!action) throw new Error(`onehub has no action called ${name.slice("onehub_".length)}.`);
  return proposeAction(action, input, chat, outbox);
}

function formatRowsOf(result: pg.QueryArrayResult): string {
  return formatRows(
    result.fields.map((f) => f.name),
    result.rows,
  );
}
