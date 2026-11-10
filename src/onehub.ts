import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type http from "node:http";
import pg from "pg";
import { z } from "zod";
import { sameSecret } from "./admin/auth.js";
import { config } from "./config.js";
import { findContact } from "./contacts.js";
import { db } from "./db.js";
import { clip } from "./format.js";
import type { ChatContext, Outbox } from "./types.js";

// onehub is the family business's back office. Friday can read its database through a read-only role, and run a
// few actions through onehub's own internal API, straight away; the person is sent onehub's own account of what it
// did. Only the numbers in ONEHUB_USERS get any of this, and only in private chats: in groups other people's messages are in the conversation and every reply is public.
// The one exception is the shipping label (onehub_resi) in the groups listed in ONEHUB_RESI_GROUPS: a label is meant
// to be passed around the warehouse, and it's still asked for by, and made as, one of the ONEHUB_USERS.

export const onehubEnabled = config.onehubUsers.length > 0 && Boolean(config.ONEHUB_DATABASE_URL || config.ONEHUB_API_URL);

export function onehubAllowed(chat: ChatContext): boolean {
  return onehubEnabled && !chat.isGroup && config.onehubUsers.includes(chat.sender.number);
}

/** Just onehub_resi: wherever onehubAllowed, and also in ONEHUB_RESI_GROUPS for the same people. */
export function onehubResiAllowed(chat: ChatContext): boolean {
  return (
    onehubEnabled &&
    config.onehubUsers.includes(chat.sender.number) &&
    (!chat.isGroup || config.onehubResiGroups.includes(chat.chatId))
  );
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
  return clip(text.replace(/\s+/g, " "), 300);
}

/** Rows as "a | b | c" lines under a header, capped so one query can't flood the conversation. */
export function formatRows(fields: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "No rows.";
  const lines = [fields.join(" | "), ...rows.slice(0, MAX_ROWS).map((row) => row.map(cellText).join(" | "))];
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = `${clip(text, MAX_CHARS)}\n…(cut off)`;
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

let actions: { list: ActionInfo[]; at: number } | undefined;

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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

/** Runs an action: onehub works out what it will do (its preview), then does it, and the person is told both. */
async function runAction(action: ActionInfo, params: unknown, chat: ChatContext, outbox: Outbox): Promise<string> {
  const requestedBy = { name: chat.sender.name, number: chat.sender.number };
  const preview = await api<{ summary: string; token?: string }>("POST", `/actions/${action.name}/preview`, { params, requested_by: requestedBy });
  let result: { message: string };
  try {
    result = await api<{ message: string }>("POST", `/actions/${action.name}/execute`, { params, token: preview.token ?? null, requested_by: requestedBy });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`onehub didn't run it: ${message}`);
  }
  // Sent by code, not by Claude, so what the person reads is exactly what onehub did.
  await outbox.sendText(chat.chatId, `✅ ${result.message}\n\n${preview.summary}`);
  return `onehub ran it: ${result.message}\nThey were sent that with onehub's summary, so don't repeat it; answer in one short line at most.`;
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
    description: `${a.description}\n\nThis runs at once in onehub, so only use it when this person asked for exactly this.`,
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
  return runAction(action, input, chat, outbox);
}

function formatRowsOf(result: pg.QueryArrayResult): string {
  return formatRows(
    result.fields.map((f) => f.name),
    result.rows,
  );
}

// --- Notices from onehub -------------------------------------------------------------------------------------------

// onehub pushes what it can't wait for anyone to ask about (a buyer's chat about to pass Shopee's 12-hour reply
// limit, a courier handover sheet that was just closed) to the people in ONEHUB_USERS and the groups in
// ONEHUB_NOTICE_GROUPS, word for word, with at most one file. It calls Friday's local web port with the same token
// Friday uses to call onehub, so there's no new secret to keep. nginx doesn't route /onehub/ to Friday, and anything
// that still arrives through it (it adds X-Forwarded-Proto) is refused: only processes on this server can send.

export const onehubNoticesEnabled =
  Boolean(config.ONEHUB_API_TOKEN) && (config.onehubUsers.length > 0 || config.onehubNoticeGroups.length > 0);

const NOTICE_MAX_FILE = 5 * 1024 * 1024;

const NoticeInput = z.object({
  to: z.array(z.string().min(1)).min(1).max(10),
  text: z.string().trim().min(1).max(4000),
  // Sent as a WhatsApp document with the text as its caption.
  file: z
    .object({
      file_name: z.string().trim().min(1).max(120),
      mimetype: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
      data: z.base64().min(1).max(Math.ceil((NOTICE_MAX_FILE * 4) / 3) + 4),
    })
    .optional(),
});

const NOTICE_MAX_BODY = 8 * 1024 * 1024;

type NoticeAnswer = { status: number; body: Record<string, unknown> };

/** A group id listed in ONEHUB_NOTICE_GROUPS, or a contact (by name or number) in ONEHUB_USERS; anyone else is nobody. */
function noticeTarget(who: string, outbox: Outbox): { name: string; chatId: string } | undefined {
  const group = who.trim();
  if (group.endsWith("@g.us")) return config.onehubNoticeGroups.includes(group) ? { name: group, chatId: group } : undefined;
  const contact = findContact(who);
  if (!contact || !config.onehubUsers.includes(contact.number)) return undefined;
  return { name: contact.name, chatId: outbox.chatIdFor(contact.number) };
}

/** Checks and delivers one notice. Recipients outside ONEHUB_USERS and ONEHUB_NOTICE_GROUPS are skipped, never messaged. */
export async function deliverOnehubNotice(
  headers: http.IncomingHttpHeaders,
  rawBody: string,
  outbox: Outbox,
): Promise<NoticeAnswer> {
  if (!onehubNoticesEnabled || headers["x-forwarded-proto"] !== undefined || headers["x-real-ip"] !== undefined) {
    return { status: 404, body: { error: "not found" } };
  }
  const auth = String(headers.authorization ?? "");
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice("Bearer ".length), config.ONEHUB_API_TOKEN)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  let input: z.infer<typeof NoticeInput>;
  try {
    input = NoticeInput.parse(JSON.parse(rawBody));
  } catch {
    return { status: 422, body: { error: "Send JSON: {\"to\": [\"name, number or group id\"], \"text\": \"…\", \"file\"?: {file_name, mimetype, data (base64)}}." } };
  }

  const file = input.file && {
    data: Buffer.from(input.file.data, "base64"),
    fileName: input.file.file_name.replace(/[\\/]/g, "-"),
    mimetype: input.file.mimetype,
    caption: input.text,
  };
  const sent: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const who of input.to) {
    const target = noticeTarget(who, outbox);
    if (!target) {
      skipped.push(who);
      continue;
    }
    if (seen.has(target.chatId)) continue;
    seen.add(target.chatId);
    if (file) await outbox.sendFile(target.chatId, file);
    else await outbox.sendText(target.chatId, input.text);
    sent.push(target.name);
  }
  if (skipped.length) console.error(`onehub notice: not in ONEHUB_USERS or ONEHUB_NOTICE_GROUPS, skipped: ${skipped.join(", ")}`);
  if (!sent.length) return { status: 422, body: { error: "None of the recipients may receive onehub notices.", skipped } };
  return { status: 200, body: { sent, skipped } };
}

/** POST /onehub/notice on Friday's local web port. */
export async function handleOnehubNotice(req: http.IncomingMessage, res: http.ServerResponse, outbox: Outbox): Promise<void> {
  const answer = (a: NoticeAnswer) => {
    res.writeHead(a.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(a.body));
  };
  if (req.method !== "POST") return answer({ status: 405, body: { error: "POST only" } });
  // Read to the end even past the limit, so the answer isn't destroyed with the request.
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= NOTICE_MAX_BODY) chunks.push(chunk);
  }
  if (size > NOTICE_MAX_BODY) return answer({ status: 413, body: { error: "too large" } });
  try {
    answer(await deliverOnehubNotice(req.headers, Buffer.concat(chunks).toString("utf8"), outbox));
  } catch (err) {
    console.error("onehub notice failed:", err instanceof Error ? err.message : "unknown error");
    answer({ status: 502, body: { error: "WhatsApp didn't take the message." } });
  }
}
