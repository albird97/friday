import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { config, type Contact } from "../config.js";
import { allContacts, isAdmin } from "../contacts.js";
import { db } from "../db.js";
import { googleEnabled } from "../google.js";
import { hevyEnabled } from "../hevy.js";
import { imageProvider } from "../images.js";
import { recentProblems } from "../logging.js";
import { chatModels, currentModel } from "../model.js";
import { connectionEvents, lastTurnFailure, startedAt, whatsappStatus, type WhatsAppStatus } from "../monitor.js";
import { onehubEnabled } from "../onehub.js";
import { activePauses, EVERYWHERE, type Pause } from "../pause.js";
import { isTerminalChat, type Kind } from "../reminders.js";
import { shopeeEnabled } from "../shopee.js";
import { smartlifeEnabled } from "../smartlife.js";
import { spotifyEnabled } from "../spotify.js";
import { version } from "../status.js";
import { isStyle } from "../styles.js";
import { fromLocal, localDay } from "../time.js";
import { transcriptionEnabled } from "../transcribe.js";
import type { Outbox } from "../types.js";
import { costOf, type Usage } from "../usage.js";
import type { Attention, DayStat, ErrandRow, GroupRow, GuestRow, PersonRow, RangeDays, ScheduleRow, Severity, Snapshot, ToolStat } from "./types.js";

// The dashboard's Snapshot (see types.ts), read from the database and the running process. It runs every 30 seconds
// while the page is open, so each query is prepared once and adds up in SQL, and the slow parts (WhatsApp's list of
// groups, what's on disk) are cached. Nothing here reads what anyone wrote, except the schedule texts the admin may see.

export type SnapshotOptions = {
  range: RangeDays;
  now?: number;
  /** The signed-in session's id (admin_sessions.id), to mark it as the current one. */
  currentSession?: string;
  /** For the list of groups Friday is in (cached, never waited on for long). */
  outbox?: Outbox;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export async function snapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const now = opts.now ?? Date.now();
  const when = calendar(now, opts.range);
  const contacts = allContacts();
  const contactNames = new Map(contacts.map((c) => [c.number, c.name]));

  const spend = spending(earlier(when.days[0], `${when.previousMonth}-01`), when.today);
  const spendInRange = spend.filter((r) => r.day >= when.days[0]);
  const chats = chatTurns(when);
  const byNumber = activityBy(chats, (r) => r.number, (r) => r.name);
  // Guests are answered in groups: a removed contact's old private chats don't make them one.
  const guestActivity = activityBy(chats.filter((r) => isGroupChat(r.chatId) && !contactNames.has(r.number)), (r) => r.number, (r) => r.name);
  const privates = privateChats(chats);
  const nameOf = namer(contactNames, byNumber, spend);

  const counts = turnsPerDay(when);
  const times = answerTimes(when);
  const daily = dailyStats(when, counts, times.byDay, spend, nameOf);
  const today = daily.find((d) => d.day === when.today)!;
  const yesterday = daily.find((d) => d.day === when.yesterday)!;
  const heatmap = heatmapOf(when);
  const hours = heatmap[0].map((_, hour) => heatmap.reduce((sum, weekday) => sum + weekday[hour], 0));
  const tools = toolUse(when);

  const pauses = new Map(activePauses(now).map((p) => [p.chatId, p]));
  const models = new Map(chatModels().map((m) => [m.chatId, m.model]));
  const styles = chatStyles();
  const contexts = contextChats();
  const reminders = activeReminders();
  const links = linkedAccounts();
  const traces: GroupTraces = { activity: activityBy(chats, (r) => r.chatId, (r) => r.chatName), pauses, models, styles, contexts, reminders };
  const known = groupsInHistory(traces);
  const listed = await whatsappGroups(opts.outbox, now, known.size > 0);
  const groups = groupRows(listed, known, traces);
  const groupNames = new Map(groups.map((g) => [g.chatId, g.name]));
  const requests = accessRequests(when, contactNames);
  const security = securityOf(now, opts.currentSession);

  const disk = onDisk(now);
  const memory = process.memoryUsage();
  const whatsapp = whatsappStatus();
  const stopped = pauses.has(EVERYWHERE);
  const lastTurnAt = lastAnswerAt();
  const spendBy = groupBy(spend, (r) => r.number);
  const people = contacts.map((c) => personRow(c, { when, byNumber, spendBy, links, models, styles, privates }));
  const owing = byPerson(spend.filter((r) => r.day === when.today), nameOf);

  return {
    generatedAt: now,
    range: opts.range,
    days: when.days,
    timezone: config.TIMEZONE,
    botName: config.BOT_NAME,
    adminName: config.contacts[0]?.name ?? "Admin",
    attention: attentionOf({
      now,
      whatsapp,
      stopped,
      failures: recentFailures(now),
      lastTurnAt,
      todayDollars: today.dollars,
      owing,
      rss: memory.rss,
      memoryLimit: disk.memoryLimit,
      disk: disk.storage.disk,
      backups: disk.backups,
      reminders,
      tools,
      loginFailures: security.failures24h,
      accessRequests: requests.length,
    }),

    status: {
      whatsapp,
      stopped,
      lastTurnAt,
      lastFailure: lastTurnFailure() ?? null,
      nextScheduleAt: reminders.find((r) => r.dueAt > now)?.dueAt ?? null,
    },

    today: {
      day: when.today,
      dollars: today.dollars,
      messages: today.messages,
      failed: today.failed,
      refused: counts.get(when.today)?.refused ?? 0,
      people: contacts.filter((c) => (byNumber.get(c.number)?.today ?? 0) > 0).length,
      contacts: contacts.length,
      guests: [...guestActivity.values()].filter((a) => a.today > 0).length,
      p50Ms: today.p50Ms,
      p95Ms: today.p95Ms,
      yesterday: { dollars: yesterday.dollars, messages: yesterday.messages },
    },

    month: monthOf(when, now, spend),
    daily,
    costs: costsOf(spendInRange, nameOf),

    activity: {
      total: sum(daily.map((d) => d.messages)),
      failed: sum(daily.map((d) => d.failed)),
      refused: sum([...counts.values()].map((c) => c.refused)),
      ...latency(times.all),
      heatmap,
      quietestHour: sum(hours) ? hours.indexOf(Math.min(...hours)) : null,
      busiestHour: sum(hours) ? hours.indexOf(Math.max(...hours)) : null,
      tools: toolStats(tools, sum(spendInRange.map((r) => r.webSearches))),
    },

    people,
    guests: guestRows(when, guestActivity, spendBy, nameOf),
    accessRequests: requests,
    groups,
    schedules: schedulesOf(now, reminders, groupNames, contactNames, privates.numbers),
    integrations: integrationsOf(now, when, tools, links, contexts),

    settings: {
      model: currentModel(),
      effort: config.FRIDAY_EFFORT,
      chatModels: models.size,
      dailyMessageLimit: config.DAILY_MESSAGE_LIMIT,
      groupAccess: config.GROUP_ACCESS,
      sessionIdleHours: config.SESSION_IDLE_HOURS,
      sessionMaxTokens: config.SESSION_MAX_TOKENS,
      usdToIdr: config.USD_TO_IDR,
      alertTotal: config.USAGE_ALERT_DAILY_TOTAL,
      alertPerson: config.USAGE_ALERT_DAILY_PERSON,
      publicUrl: config.PUBLIC_URL,
    },

    system: {
      startedAt,
      uptimeMs: Math.max(0, now - startedAt),
      version: VERSION,
      node: process.version,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, limit: disk.memoryLimit },
      host: hostOf(),
      storage: disk.storage,
      backups: disk.backups,
    },

    connection: connectionEvents(),
    problems: recentProblems(),
    security,
  };
}

// --- Days ------------------------------------------------------------------------------------------------------------

type Calendar = {
  today: string;
  yesterday: string;
  /** The range, oldest first. */
  days: string[];
  month: string;
  previousMonth: string;
  /** Local midnights starting the range, this month, today and tomorrow. */
  rangeStart: number;
  monthStart: number;
  todayStart: number;
  tomorrowStart: number;
};

function calendar(now: number, range: RangeDays): Calendar {
  const today = localDay(new Date(now));
  const days = Array.from({ length: range }, (_, i) => addDays(today, i + 1 - range));
  const month = today.slice(0, 7);
  return {
    today,
    yesterday: addDays(today, -1),
    days,
    month,
    previousMonth: addDays(`${month}-01`, -1).slice(0, 7),
    rangeStart: fromLocal(days[0]).getTime(),
    monthStart: fromLocal(`${month}-01`).getTime(),
    todayStart: fromLocal(today).getTime(),
    tomorrowStart: fromLocal(addDays(today, 1)).getTime(),
  };
}

/** Moves a day by calendar days: by date, never by 24 hours, which can skip or repeat a day around daylight saving. */
function addDays(day: string, n: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

function daysInMonth(month: string): number {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate(); // day 0 of the next month is the last of this one
}

const earlier = (a: string, b: string) => (a < b ? a : b);

// --- Money -----------------------------------------------------------------------------------------------------------

type Spend = { day: string; number: string; name: string; model: string; dollars: number; fresh: number; cached: number; output: number; webSearches: number; cacheSavings: number };

const NO_TOKENS: Usage = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, webSearches: 0 };

/** Estimated dollars (list prices, like /usage) per day, person and model, oldest day first. */
function spending(from: string, to: string): Spend[] {
  const rows = sql(
    `SELECT day, number, MAX(name) AS name, model, SUM(input) AS input, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite5m,
            SUM(cache_write_1h) AS cacheWrite1h, SUM(output) AS output, SUM(web_searches) AS webSearches
       FROM token_usage WHERE day BETWEEN ? AND ? GROUP BY day, number, model ORDER BY day`,
  ).all(from, to) as (Usage & { day: string; number: string; name: string; model: string })[];
  return rows.map((r) => ({
    day: r.day,
    number: r.number,
    name: r.name,
    model: r.model,
    dollars: costOf(r.model, r),
    fresh: r.input + r.cacheWrite5m + r.cacheWrite1h,
    cached: r.cacheRead,
    output: r.output,
    webSearches: r.webSearches,
    // Cache reads cost a fraction of fresh input; the difference is what the cache saved.
    cacheSavings: costOf(r.model, { ...NO_TOKENS, input: r.cacheRead }) - costOf(r.model, { ...NO_TOKENS, cacheRead: r.cacheRead }),
  }));
}

const dollarsOf = (rows: Spend[]) => sum(rows.map((r) => r.dollars));

/** Dollars per person, most first. */
function byPerson(rows: Spend[], nameOf: (number: string) => string): { number: string; name: string; dollars: number }[] {
  return [...groupBy(rows, (r) => r.number)]
    .map(([number, own]) => ({ number, name: nameOf(number), dollars: dollarsOf(own) }))
    .sort((a, b) => b.dollars - a.dollars || a.name.localeCompare(b.name, "id"));
}

/** Today counts for as much of it as has passed: counted whole, the first days of a month read far too low. */
function monthOf(when: Calendar, now: number, spend: Spend[]): Snapshot["month"] {
  const dollars = dollarsOf(spend.filter((r) => r.day.startsWith(when.month)));
  // At least half a day, so a first hour's few cents aren't carried to a whole month.
  const elapsedDays = Math.max(0.5, (now - when.monthStart) / DAY);
  const previous = spend.filter((r) => r.day.startsWith(when.previousMonth));
  return {
    month: when.month,
    dollars,
    projected: (dollars / elapsedDays) * daysInMonth(when.month),
    previous: { month: when.previousMonth, dollars: dollarsOf(previous), toDate: toSameMoment(when, now, previous) },
  };
}

/**
 * Last month up to this moment of the month: the days before today's date, and that date's day as far as today has
 * gone (token use is kept per day). A month too short to have today's date counts in full.
 */
function toSameMoment(when: Calendar, now: number, previous: Spend[]): number {
  const date = Number(when.today.slice(8));
  if (daysInMonth(when.previousMonth) < date) return dollarsOf(previous);
  const dateOf = (r: Spend) => Number(r.day.slice(8));
  const todayShare = (now - when.todayStart) / (when.tomorrowStart - when.todayStart);
  return dollarsOf(previous.filter((r) => dateOf(r) < date)) + dollarsOf(previous.filter((r) => dateOf(r) === date)) * todayShare;
}

function costsOf(rows: Spend[], nameOf: (number: string) => string): Snapshot["costs"] {
  const fresh = sum(rows.map((r) => r.fresh));
  const cached = sum(rows.map((r) => r.cached));
  const models = [...groupBy(rows, (r) => r.model)].map(([model, own]) => ({
    model,
    dollars: dollarsOf(own),
    tokens: sum(own.map((r) => r.fresh + r.cached + r.output)),
  }));
  return {
    total: dollarsOf(rows),
    people: byPerson(rows, nameOf),
    models: models.sort((a, b) => b.dollars - a.dollars || a.model.localeCompare(b.model)),
    tokens: {
      fresh,
      cached,
      output: sum(rows.map((r) => r.output)),
      webSearches: sum(rows.map((r) => r.webSearches)),
      cacheSavings: sum(rows.map((r) => r.cacheSavings)),
      cacheShare: fresh + cached > 0 ? cached / (fresh + cached) : 0,
    },
  };
}

// --- Messages --------------------------------------------------------------------------------------------------------

type TurnDay = { day: string; messages: number; groupMessages: number; failed: number; refused: number };

/** Answered messages per day of the range; chats ending in @g.us are groups, the rest (errands, the terminal) private. */
function turnsPerDay(when: Calendar): Map<string, TurnDay> {
  const rows = sql(
    `SELECT day, COUNT(*) AS messages, SUM(chat_id LIKE '%@g.us') AS groupMessages, SUM(outcome = 'failed') AS failed,
            SUM(outcome = 'refused') AS refused
       FROM turns WHERE day BETWEEN ? AND ? GROUP BY day`,
  ).all(when.days[0], when.today) as TurnDay[];
  return new Map(rows.map((r) => [r.day, r]));
}

/** How long good answers took, in ascending milliseconds: per day of the range, and all of it. */
function answerTimes(when: Calendar): { byDay: Map<string, number[]>; all: number[] } {
  const rows = sql("SELECT day, ms FROM turns WHERE day BETWEEN ? AND ? AND outcome = 'ok' ORDER BY ms").all(when.days[0], when.today) as {
    day: string;
    ms: number;
  }[];
  const byDay = new Map([...groupBy(rows, (r) => r.day)].map(([day, own]) => [day, own.map((r) => r.ms)]));
  return { byDay, all: rows.map((r) => r.ms) };
}

/** Nearest-rank median and 95th percentile of ascending values; null without any. */
function latency(sorted: number[]): { p50Ms: number | null; p95Ms: number | null } {
  const rank = (p: number) => (sorted.length ? sorted[Math.ceil((p * sorted.length) / 100) - 1] : null);
  return { p50Ms: rank(50), p95Ms: rank(95) };
}

function dailyStats(
  when: Calendar,
  counts: Map<string, TurnDay>,
  times: Map<string, number[]>,
  spend: Spend[],
  nameOf: (number: string) => string,
): DayStat[] {
  const spendOn = groupBy(spend, (r) => r.day);
  return when.days.map((day) => {
    const c = counts.get(day);
    const cost = spendOn.get(day) ?? [];
    return {
      day,
      dollars: dollarsOf(cost),
      messages: c?.messages ?? 0,
      privateMessages: (c?.messages ?? 0) - (c?.groupMessages ?? 0),
      groupMessages: c?.groupMessages ?? 0,
      failed: c?.failed ?? 0,
      ...latency(times.get(day) ?? []),
      topPeople: byPerson(cost, nameOf)
        .filter((p) => p.dollars > 0)
        .slice(0, 3)
        .map(({ name, dollars }) => ({ name, dollars })),
    };
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekdayHour = new Intl.DateTimeFormat("en-US", { timeZone: config.TIMEZONE, weekday: "short", hour: "numeric", hourCycle: "h23" });

/** Answered messages in the range per local weekday (0 = Monday) and hour. */
function heatmapOf(when: Calendar): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  // Counted per quarter hour (900000 ms) in SQL. Every timezone is a whole number of quarter hours off UTC, so each
  // quarter falls within one local hour.
  const quarters = sql("SELECT at / 900000 AS quarter, COUNT(*) AS n FROM turns WHERE at >= ? AND at < ? GROUP BY quarter").all(
    when.rangeStart,
    when.tomorrowStart,
  ) as { quarter: number; n: number }[];
  for (const { quarter, n } of quarters) {
    const parts = weekdayHour.formatToParts(quarter * 900_000);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    grid[WEEKDAYS.indexOf(part("weekday"))][Number(part("hour"))] += n;
  }
  return grid;
}

type ChatTurns = { chatId: string; number: string; name: string; chatName: string; lastAt: number; messages: number; today: number };
type Activity = { name: string; lastAt: number; messages: number; today: number };

/**
 * Turns per chat and person: in the range, today, and the latest one with the names it carried. Over all of turns (kept
 * 180 days) rather than the range, so "last active" means just that and groups from before the range keep their names.
 */
function chatTurns(when: Calendar): ChatTurns[] {
  // With a single MAX(), SQLite takes name and chat_name from the row that has it: the latest turn.
  return sql(
    `SELECT chat_id AS chatId, number, name, chat_name AS chatName, MAX(at) AS lastAt,
            SUM(at >= @rangeStart AND at < @tomorrowStart) AS messages, SUM(at >= @todayStart AND at < @tomorrowStart) AS today
       FROM turns GROUP BY chat_id, number`,
  ).all({ rangeStart: when.rangeStart, todayStart: when.todayStart, tomorrowStart: when.tomorrowStart }) as ChatTurns[];
}

/** The same per person or per chat, named as in their latest turn. */
function activityBy(rows: ChatTurns[], key: (row: ChatTurns) => string, name: (row: ChatTurns) => string): Map<string, Activity> {
  const totals = new Map<string, Activity>();
  for (const row of rows) {
    const total = totals.get(key(row));
    if (!total) totals.set(key(row), { name: name(row), lastAt: row.lastAt, messages: row.messages, today: row.today });
    else {
      total.messages += row.messages;
      total.today += row.today;
      if (row.lastAt > total.lastAt) Object.assign(total, { name: name(row), lastAt: row.lastAt });
    }
  }
  return totals;
}

/** A number's name: the contact's, else the latest one seen in a turn or in token use, else the number. */
function namer(contactNames: Map<string, string>, byNumber: Map<string, Activity>, spend: Spend[]): (number: string) => string {
  const billed = new Map(spend.map((r) => [r.number, r.name])); // oldest day first, so the latest name wins
  return (number) => contactNames.get(number) ?? byNumber.get(number)?.name ?? billed.get(number) ?? `+${number}`;
}

/** When the latest good answer ended. Answers take minutes, so only those started within a day of the newest can count. */
function lastAnswerAt(): number | null {
  const row = sql(
    `SELECT MAX(at + ms) AS endedAt FROM turns
      WHERE outcome = 'ok' AND at >= (SELECT at FROM turns WHERE outcome = 'ok' ORDER BY at DESC LIMIT 1) - ${DAY}`,
  ).get() as { endedAt: number | null };
  return row.endedAt;
}

type Failures = { count: number; firstAt: number | null; lastAt: number | null };

/** Turns that failed in the last hour; times are when they failed. */
function recentFailures(now: number): Failures {
  return sql("SELECT COUNT(*) AS count, MIN(at + ms) AS firstAt, MAX(at + ms) AS lastAt FROM turns WHERE outcome = 'failed' AND at >= ?").get(
    now - HOUR,
  ) as Failures;
}

// --- Tools -----------------------------------------------------------------------------------------------------------

type ToolUse = { tool: string; calls: number; errors: number; totalMs: number; callsToday: number; errorsToday: number };

function toolUse(when: Calendar): ToolUse[] {
  return sql(
    `SELECT tool, SUM(calls) AS calls, SUM(errors) AS errors, SUM(total_ms) AS totalMs,
            SUM(CASE WHEN day = @today THEN calls ELSE 0 END) AS callsToday, SUM(CASE WHEN day = @today THEN errors ELSE 0 END) AS errorsToday
       FROM tool_usage WHERE day BETWEEN @from AND @today GROUP BY tool`,
  ).all({ from: when.days[0], today: when.today }) as ToolUse[];
}

/** Tool calls in the range, most used first, with the web searches Claude ran itself as "web_search". */
function toolStats(tools: ToolUse[], webSearches: number): ToolStat[] {
  const stats = tools.map((t) => ({ tool: t.tool, calls: t.calls, errors: t.errors, avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0 }));
  if (webSearches > 0) {
    // Claude's own searches happen inside its answer, untimed: they add calls, not time.
    const search = stats.find((s) => s.tool === "web_search");
    if (search) search.calls += webSearches;
    else stats.push({ tool: "web_search", calls: webSearches, errors: 0, avgMs: 0 });
  }
  return stats.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function callsOf(tools: ToolUse[], ...names: string[]): { today: number; range: number } {
  const used = tools.filter((t) => names.includes(t.tool));
  return { today: sum(used.map((t) => t.callsToday)), range: sum(used.map((t) => t.calls)) };
}

// --- People ----------------------------------------------------------------------------------------------------------

const isGroupChat = (chatId: string) => chatId.endsWith("@g.us");
const privateChat = (number: string) => `${number}@s.whatsapp.net`;
/** A chat with one person: not a group, an errand's own conversation ("errand:12") or the terminal. */
const isPrivateChat = (chatId: string) => !isGroupChat(chatId) && !chatId.startsWith("errand:") && !isTerminalChat(chatId);

/** chats: each number's private chats, most recently active first; numbers: whom each of those chats is with. */
type PrivateChats = { chats: Map<string, string[]>; numbers: Map<string, string> };

/**
 * Baileys 7 often names a 1:1 chat "<lid>@lid" instead of "<number>@s.whatsapp.net", and /switch, /style and schedules
 * made in it are kept under that name. Only turns tie such a chat to a number.
 */
function privateChats(rows: ChatTurns[]): PrivateChats {
  const chats = new Map<string, string[]>();
  const numbers = new Map<string, string>();
  for (const { chatId, number } of rows.filter((r) => isPrivateChat(r.chatId)).sort((a, b) => b.lastAt - a.lastAt)) {
    if (!numbers.has(chatId)) numbers.set(chatId, number);
    chats.set(number, [...(chats.get(number) ?? []), chatId]);
  }
  return { chats, numbers };
}

/** A number's private chats, most recently active first, and its phone JID (last, if it has had no turns). */
const chatsOf = (privates: PrivateChats, number: string) => [...new Set([...(privates.chats.get(number) ?? []), privateChat(number)])];

type Links = { google: Set<string>; youtube: Set<string>; hevy: Set<string>; spotify: Set<string>; shops: Map<string, number> };

/** Who linked which account, by number only (the tokens stay where they are). */
function linkedAccounts(): Links {
  const numbersIn = (table: string) => new Set((sql(`SELECT number FROM ${table}`).all() as { number: string }[]).map((r) => r.number));
  const shops = sql("SELECT number, COUNT(*) AS shops FROM shopee_shops GROUP BY number").all() as { number: string; shops: number }[];
  return {
    google: numbersIn("google_accounts"),
    youtube: numbersIn("google_youtube"),
    hevy: numbersIn("hevy_accounts"),
    spotify: numbersIn("spotify_accounts"),
    shops: new Map(shops.map((r) => [r.number, r.shops])),
  };
}

type Styles = Map<string, { chatName: string; style: string }>;

function chatStyles(): Styles {
  const rows = sql("SELECT chat_id AS chatId, chat_name AS chatName, style FROM chat_styles").all() as { chatId: string; chatName: string; style: string }[];
  return new Map(rows.filter((r) => isStyle(r.style)).map((r) => [r.chatId, r]));
}

/** Groups where Friday reads along (/context on). */
function contextChats(): Set<string> {
  return new Set((sql("SELECT substr(key, 9) AS chatId FROM settings WHERE key LIKE 'context:%'").all() as { chatId: string }[]).map((r) => r.chatId));
}

type PersonFacts = {
  when: Calendar;
  byNumber: Map<string, Activity>;
  spendBy: Map<string, Spend[]>;
  links: Links;
  models: Map<string, string>;
  styles: Styles;
  privates: PrivateChats;
};

function personRow(contact: Contact, f: PersonFacts): PersonRow {
  const { number } = contact;
  const admin = isAdmin(number);
  const fromEnv = config.contacts.some((c) => c.number === number);
  const activity = f.byNumber.get(number);
  const own = f.spendBy.get(number) ?? [];
  // Model and style: of their private chats that have one, the most recently active chat's.
  const chats = chatsOf(f.privates, number);
  const ownModel = chats.map((chatId) => f.models.get(chatId)).find((model) => model !== undefined);
  const style = chats.map((chatId) => f.styles.get(chatId)?.style).find((s) => s !== undefined);
  return {
    number,
    name: contact.name,
    admin,
    source: fromEnv ? "env" : "added",
    addedAt: fromEnv ? null : addedAt(number),
    messagesToday: activity?.today ?? 0,
    quotaToday: (sql("SELECT count FROM usage WHERE number = ? AND day = ?").get(number, f.when.today) as { count: number } | undefined)?.count ?? 0,
    messagesRange: activity?.messages ?? 0,
    dollarsToday: dollarsOf(own.filter((r) => r.day === f.when.today)),
    dollarsMonth: dollarsOf(own.filter((r) => r.day.startsWith(f.when.month))),
    dollarsRange: dollarsOf(own.filter((r) => r.day >= f.when.days[0])),
    lastActiveAt: activity?.lastAt ?? null,
    links: {
      google: f.links.google.has(number),
      youtube: f.links.youtube.has(number),
      hevy: f.links.hevy.has(number),
      spotify: f.links.spotify.has(number),
      shopeeShops: f.links.shops.get(number) ?? 0,
    },
    ownModel: ownModel ?? null,
    style: style ?? null,
    can: {
      errands: config.errandUsers.includes(number),
      onehub: config.onehubUsers.includes(number),
      smartlife: smartlifeEnabled && (admin || config.tuyaUsers.includes(number)),
      switchModel: admin || config.switchUsers.includes(number),
    },
  };
}

function addedAt(number: string): number | null {
  return (sql("SELECT added_at AS addedAt FROM contacts WHERE number = ?").get(number) as { addedAt: number } | undefined)?.addedAt ?? null;
}

/**
 * People who aren't contacts but were answered in a group during the range, from their turns in groups. Their dollars
 * are all of theirs in the range: token use isn't kept per chat.
 */
function guestRows(when: Calendar, guestActivity: Map<string, Activity>, spendBy: Map<string, Spend[]>, nameOf: (number: string) => string): GuestRow[] {
  const guests = [...guestActivity]
    .filter(([, activity]) => activity.messages > 0)
    .map(([number, activity]) => ({
      number,
      name: nameOf(number),
      messagesRange: activity.messages,
      dollarsRange: dollarsOf((spendBy.get(number) ?? []).filter((r) => r.day >= when.days[0])),
      lastActiveAt: activity.lastAt,
    }));
  return guests.sort((a, b) => b.messagesRange - a.messagesRange || b.dollarsRange - a.dollarsRange || a.name.localeCompare(b.name, "id"));
}

// A request the admin has let be for a month shouldn't stay on the list, and raise attention, forever.
const ACCESS_REQUEST_DAYS = 30;

/** Website access requests of the last 30 days (today included) from people who aren't contacts yet, newest first. */
function accessRequests(when: Calendar, contactNames: Map<string, string>): Snapshot["accessRequests"] {
  const rows = sql("SELECT number, name, day FROM access_requests WHERE day >= ? ORDER BY day DESC, rowid DESC").all(
    addDays(when.today, 1 - ACCESS_REQUEST_DAYS),
  ) as Snapshot["accessRequests"];
  return rows.filter((r) => !contactNames.has(r.number));
}

// --- Groups ----------------------------------------------------------------------------------------------------------

type Listed = Map<string, { name: string; size?: number }>;
type GroupCache = { groups?: Listed; expiresAt: number; refreshing?: Promise<void>; failing: boolean };

const GROUPS_FRESH_MS = 10 * MINUTE;
const GROUPS_RETRY_MS = MINUTE;
const GROUPS_WAIT_MS = 3_000;
const groupCaches = new WeakMap<Outbox, GroupCache>();

/**
 * The groups Friday is in, as WhatsApp lists them, refreshed every 10 minutes. A snapshot waits at most 3 seconds for a
 * refresh; a slow or failed one leaves the last list (or none yet), and a slow one finishes in the background.
 * inSome: history says Friday is in groups.
 */
async function whatsappGroups(outbox: Outbox | undefined, now: number, inSome: boolean): Promise<Listed | undefined> {
  const list = outbox?.groups;
  if (!outbox || !list) return undefined;
  const cache = groupCaches.get(outbox) ?? { expiresAt: 0, failing: false };
  groupCaches.set(outbox, cache);
  if (now >= cache.expiresAt && !cache.refreshing) {
    cache.refreshing = refreshGroups(() => list.call(outbox), cache, now, inSome).finally(() => {
      cache.refreshing = undefined;
    });
    await waitAtMost(cache.refreshing, GROUPS_WAIT_MS);
  }
  return cache.groups;
}

async function refreshGroups(list: NonNullable<Outbox["groups"]>, cache: GroupCache, now: number, inSome: boolean): Promise<void> {
  try {
    const groups = await list();
    // Baileys resolves [] when WhatsApp doesn't answer in time: with groups known, that's no answer, not "left them all".
    if (!groups.length && (cache.groups?.size || inSome)) throw new Error("WhatsApp listed no groups");
    cache.groups = new Map(groups.map((g) => [g.id, { name: g.name, size: g.size }]));
    cache.expiresAt = now + GROUPS_FRESH_MS;
    cache.failing = false;
  } catch (err) {
    // Once per outage: the page asks every 30 seconds, and the problem log shouldn't fill up with this.
    if (!cache.failing) console.warn("Couldn't list WhatsApp groups for the dashboard:", err instanceof Error ? err.message : err);
    cache.expiresAt = now + GROUPS_RETRY_MS;
    cache.failing = true;
  }
}

async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}

/** What Friday keeps per chat that a group's row is made of. */
type GroupTraces = {
  activity: Map<string, Activity>;
  pauses: Map<string, Pause>;
  models: Map<string, string>;
  styles: Styles;
  contexts: Set<string>;
  reminders: ReminderRow[];
};

/** Groups with a trace in the database: turns, a stored conversation, a pause, a style, a schedule, /context or a model. */
function groupsInHistory(f: GroupTraces): Set<string> {
  const sources = [f.activity.keys(), groupSessions(), f.pauses.keys(), f.styles.keys(), f.reminders.map((r) => r.chatId), f.contexts, f.models.keys()];
  return new Set(sources.flatMap((source) => [...source]).filter(isGroupChat));
}

/** Every group Friday is in or has a trace of, busiest first. */
function groupRows(listedGroups: Listed | undefined, known: Set<string>, f: GroupTraces): GroupRow[] {
  const remindersTo = groupBy(f.reminders, (r) => r.chatId);
  const ids = new Set([...(listedGroups?.keys() ?? []), ...known].filter(isGroupChat));
  const rows = [...ids].map((chatId): GroupRow => {
    const listed = listedGroups?.get(chatId);
    const activity = f.activity.get(chatId);
    const pause = f.pauses.get(chatId);
    const style = f.styles.get(chatId);
    const schedules = remindersTo.get(chatId) ?? [];
    return {
      chatId,
      name: listed?.name || activity?.name || pause?.chatName || style?.chatName || schedules.find((r) => r.chatName)?.chatName || "Grup tanpa nama",
      members: listed?.size ?? null,
      // Before WhatsApp has ever answered, assume Friday is still in all of them.
      inGroup: listedGroups ? listed !== undefined : true,
      messagesToday: activity?.today ?? 0,
      messagesRange: activity?.messages ?? 0,
      lastActiveAt: activity?.lastAt ?? null,
      context: f.contexts.has(chatId),
      paused: pause ? { until: pause.until } : null,
      model: f.models.get(chatId) ?? null,
      style: style?.style ?? null,
      schedules: schedules.length,
    };
  });
  return rows.sort(
    (a, b) => b.messagesRange - a.messagesRange || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name, "id"),
  );
}

/** Groups with a conversation stored (only the chat ids: the index has them, the conversations stay unread). */
function groupSessions(): string[] {
  return (sql("SELECT chat_id AS chatId FROM sessions WHERE chat_id LIKE '%@g.us'").all() as { chatId: string }[]).map((r) => r.chatId);
}

// --- Schedules -------------------------------------------------------------------------------------------------------

type ReminderRow = { id: number; chatId: string; createdBy: string; dueAt: number; cron: string | null; kind: Kind; chatName: string | null; text: string | null };

const STUCK_MS = 10 * MINUTE;
const UPCOMING = 30;

/** Active schedules, soonest first. Text leaves the database only for the admin's own and for groups'. */
function activeReminders(): ReminderRow[] {
  return sql(
    `SELECT id, chat_id AS chatId, created_by AS createdBy, due_at AS dueAt, cron, kind, chat_name AS chatName,
            CASE WHEN created_by = @admin OR chat_id LIKE '%@g.us' THEN text END AS text
       FROM reminders WHERE active = 1 ORDER BY due_at, id`,
  ).all({ admin: config.contacts[0]?.number ?? null }) as ReminderRow[];
}

function schedulesOf(
  now: number,
  reminders: ReminderRow[],
  groupNames: Map<string, string>,
  contactNames: Map<string, string>,
  chatNumbers: Map<string, string>,
): Snapshot["schedules"] {
  const count = (kind: Kind) => reminders.filter((r) => r.kind === kind).length;
  const where = (r: ReminderRow) => {
    if (r.chatName) return r.chatName;
    if (isGroupChat(r.chatId)) return groupNames.get(r.chatId) ?? r.chatId;
    // A chat named by LID says nothing about whose it is; only its turns do.
    const phone = /^(\d+)@s\.whatsapp\.net$/.exec(r.chatId)?.[1];
    const number = chatNumbers.get(r.chatId) ?? phone;
    return (number && contactNames.get(number)) || (phone ? `+${phone}` : "chat pribadi");
  };
  return {
    counts: { reminder: count("reminder"), message: count("message"), task: count("task") },
    overdue: reminders.filter((r) => r.dueAt < now - STUCK_MS).length,
    upcoming: reminders.slice(0, UPCOMING).map(
      (r): ScheduleRow => ({
        id: r.id,
        kind: r.kind,
        dueAt: r.dueAt,
        cron: r.cron,
        where: where(r),
        isGroup: isGroupChat(r.chatId),
        owner: contactNames.get(r.createdBy) ?? `+${r.createdBy}`,
        text: r.text,
      }),
    ),
  };
}

// --- Features --------------------------------------------------------------------------------------------------------

// As errands.ts has it: an active errand takes no more replies after 3 days of silence (ACTIVE_DAYS), and
// ERRAND_DAILY_LIMIT counts the errands started in the last 24 hours.
const ERRAND_SILENT_MS = 3 * DAY;

function integrationsOf(now: number, when: Calendar, tools: ToolUse[], links: Links, contexts: Set<string>): Snapshot["integrations"] {
  const polls = sql("SELECT COUNT(*) AS n FROM polls WHERE created_at >= ?").get(when.rangeStart) as { n: number };
  const workouts = sql(
    "SELECT COUNT(*) FILTER (WHERE status IN ('inviting', 'active')) AS active, COUNT(*) FILTER (WHERE created_at >= ?) AS started FROM group_workouts",
  ).get(when.rangeStart) as { active: number; started: number };
  const errands = sql(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'active') AND updated_at > @silent) AS active,
            COUNT(*) FILTER (WHERE created_at > @dayAgo) AS last24h
       FROM errands`,
  ).get({ silent: now - ERRAND_SILENT_MS, dayAgo: now - DAY }) as { active: number; last24h: number };
  // Who asked, whom Friday wrote to, and how far it got: never the brief or the messages. Nothing writes "expired"
  // down: an active errand silent that long simply stops taking replies.
  const recent = sql(
    `SELECT id, requester_name AS requester, target_name AS target,
            CASE WHEN status = 'active' AND updated_at <= @silent THEN 'expired' ELSE status END AS status, turns, updated_at AS updatedAt
       FROM errands ORDER BY updated_at DESC, id DESC LIMIT 10`,
  ).all({ silent: now - ERRAND_SILENT_MS }) as ErrandRow[];
  const admin = config.contacts[0]?.number;
  return {
    images: { provider: imageProvider ?? null, ...callsOf(tools, "generate_image", "edit_image") },
    voice: { enabled: transcriptionEnabled, ...callsOf(tools, "voice_note") },
    google: { enabled: googleEnabled, accounts: links.google.size, youtube: links.youtube.size },
    hevy: { enabled: hevyEnabled, accounts: links.hevy.size },
    spotify: { enabled: spotifyEnabled, accounts: links.spotify.size },
    shopee: { enabled: shopeeEnabled, shops: sum([...links.shops.values()]), sandbox: config.SHOPEE_API_URL.includes("sandbox") },
    // The admin always can, besides TUYA_USERS (counted once if listed there too).
    smartlife: { enabled: smartlifeEnabled, users: smartlifeEnabled ? new Set([...(admin ? [admin] : []), ...config.tuyaUsers]).size : 0 },
    onehub: { enabled: onehubEnabled, users: config.onehubUsers.length },
    market: callsOf(tools, "market_analysis"),
    polls: { range: polls.n },
    groupWorkouts: { active: workouts.active, range: workouts.started },
    groupContext: { groups: contexts.size },
    errands: { users: config.errandUsers.length, active: errands.active, last24h: errands.last24h, dailyLimit: config.ERRAND_DAILY_LIMIT, recent },
  };
}

// --- The machine -----------------------------------------------------------------------------------------------------

/** "c6f25cb, 05-11-2026" as /status shows it → { hash, date: "2026-11-05" }. */
const VERSION = (() => {
  const m = /^(\w+), (\d{2})-(\d{2})-(\d{4})$/.exec(version);
  return m ? { hash: m[1], date: `${m[4]}-${m[3]}-${m[2]}` } : null;
})();

const CPUS = os.cpus().length;

function hostOf(): Snapshot["system"]["host"] {
  const [one, five, fifteen] = os.loadavg();
  return { load: [one, five, fifteen], cpus: CPUS, memFree: os.freemem(), memTotal: os.totalmem(), uptimeMs: os.uptime() * 1000 };
}

type DiskFacts = { storage: Snapshot["system"]["storage"]; backups: Snapshot["system"]["backups"]; memoryLimit: number | null };

const DISK_FRESH_MS = MINUTE;
let diskCache: { facts: DiskFacts; expiresAt: number } | undefined;

/** What's on disk, and the service's memory cap: read at most once a minute, since it walks folders. */
function onDisk(now: number): DiskFacts {
  if (!diskCache || now >= diskCache.expiresAt) diskCache = { facts: readDisk(), expiresAt: now + DISK_FRESH_MS };
  return diskCache.facts;
}

function readDisk(): DiskFacts {
  const images = filesIn(path.join(config.DATA_DIR, "images")) ?? [];
  return {
    storage: {
      db: sum([config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].map((file) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0)),
      images: sum(images.map((f) => f.size)),
      imagesCount: images.length,
      disk: freeSpace(config.DATA_DIR),
    },
    backups: backupsIn(config.BACKUP_DIR),
    memoryLimit: memoryLimit(),
  };
}

/** The files in a folder, or undefined when it can't be read. */
function filesIn(dir: string, pattern = /./): { size: number; mtimeMs: number }[] | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .flatMap((entry) => fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false }) ?? []);
  } catch {
    return undefined;
  }
}

/** The nightly backups (scripts/backup.sh): how many, and the newest. */
function backupsIn(dir: string): Snapshot["system"]["backups"] {
  const files = filesIn(dir, /^friday-.*\.tar\.gz$/);
  const newest = files?.reduce<{ size: number; mtimeMs: number } | undefined>((a, b) => (a && a.mtimeMs >= b.mtimeMs ? a : b), undefined);
  return {
    dir,
    found: files !== undefined,
    count: files?.length ?? 0,
    latestAt: newest ? Math.floor(newest.mtimeMs) : null,
    latestBytes: newest?.size ?? null,
    totalBytes: sum(files?.map((f) => f.size) ?? []),
  };
}

function freeSpace(dir: string): { free: number; total: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** The cap systemd puts on the service (cgroup v2 memory.max); null when there's none or no cgroup (macOS). */
function memoryLimit(): number | null {
  try {
    const own = fs
      .readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!own) return null;
    const max = fs.readFileSync(path.join("/sys/fs/cgroup", own.slice(3), "memory.max"), "utf8").trim();
    return /^\d+$/.test(max) ? Number(max) : null;
  } catch {
    return null;
  }
}

// --- Sign-ins --------------------------------------------------------------------------------------------------------

const LOGINS_SHOWN = 30;

/** Dashboard sessions and sign-ins. A session's id and CSRF token never leave the database: SQL only says which is this one. */
function securityOf(now: number, currentSession: string | undefined): Snapshot["security"] {
  const sessions = sql(
    `SELECT id = @current AS current, created_at AS createdAt, seen_at AS seenAt, expires_at AS expiresAt, ip, agent
       FROM admin_sessions WHERE expires_at > @now ORDER BY seen_at DESC`,
  ).all({ current: currentSession ?? null, now }) as (Omit<Snapshot["security"]["sessions"][number], "current"> & { current: number | null })[];
  const logins = sql("SELECT at, ip, agent, result FROM admin_logins ORDER BY at DESC, id DESC LIMIT ?").all(LOGINS_SHOWN) as Snapshot["security"]["logins"];
  const failures = sql("SELECT COUNT(*) AS n FROM admin_logins WHERE result != 'ok' AND at > ?").get(now - DAY) as { n: number };
  return { sessions: sessions.map((s) => ({ ...s, current: s.current === 1 })), logins, failures24h: failures.n };
}

// --- What needs a look -----------------------------------------------------------------------------------------------

type Health = {
  now: number;
  whatsapp: WhatsAppStatus;
  stopped: boolean;
  failures: Failures;
  lastTurnAt: number | null;
  todayDollars: number;
  /** Today's dollars per person, most first. */
  owing: { name: string; dollars: number }[];
  rss: number;
  memoryLimit: number | null;
  disk: { free: number; total: number } | null;
  backups: Snapshot["system"]["backups"];
  reminders: ReminderRow[];
  tools: ToolUse[];
  loginFailures: number;
  accessRequests: number;
};

// Right after a restart WhatsApp takes a few seconds to connect; that's not worth an alarm.
const WHATSAPP_GRACE_MS = MINUTE;
const BACKUP_STALE_MS = 36 * HOUR;
const SEVERITY: Record<Severity, number> = { critical: 0, serious: 1, warning: 2, info: 3 };

/** The rules in types.ts (Attention), worst first. */
function attentionOf(h: Health): Attention[] {
  const items: Attention[] = [];
  const { state, since } = h.whatsapp;
  if (state !== "open" && (state === "loggedOut" || state === "waitingForScan" || h.now - since > WHATSAPP_GRACE_MS)) {
    items.push({ code: "whatsappDown", severity: "critical", state, since });
  }
  if (h.stopped) items.push({ code: "stopped", severity: "warning" });
  if (h.failures.count > 0) {
    const recovered = h.lastTurnAt !== null && h.failures.firstAt !== null && h.lastTurnAt > h.failures.firstAt;
    items.push({
      code: "claudeFailing",
      severity: recovered ? "serious" : "critical",
      failures: h.failures.count,
      lastAt: h.failures.lastAt ?? h.now,
      message: lastTurnFailure()?.message ?? "",
    });
  }
  const { USAGE_ALERT_DAILY_TOTAL: totalLimit, USAGE_ALERT_DAILY_PERSON: personLimit } = config;
  if (totalLimit > 0 && h.todayDollars >= totalLimit) items.push({ code: "costToday", severity: "warning", dollars: h.todayDollars, limit: totalLimit });
  for (const { name, dollars } of h.owing) {
    if (personLimit > 0 && dollars >= personLimit) items.push({ code: "costPerson", severity: "warning", name, dollars, limit: personLimit });
  }
  if (h.memoryLimit && h.rss >= 0.8 * h.memoryLimit) {
    items.push({ code: "memoryHigh", severity: h.rss >= 0.9 * h.memoryLimit ? "serious" : "warning", used: h.rss, limit: h.memoryLimit });
  }
  if (h.disk && h.disk.total > 0 && h.disk.free < 0.1 * h.disk.total) {
    items.push({ code: "diskLow", severity: h.disk.free < 0.05 * h.disk.total ? "serious" : "warning", free: h.disk.free, total: h.disk.total });
  }
  if (h.backups.found && (h.backups.latestAt === null || h.now - h.backups.latestAt > BACKUP_STALE_MS)) {
    items.push({ code: "backupStale", severity: "warning", lastAt: h.backups.latestAt });
  }
  const stuck = h.reminders.filter((r) => r.dueAt < h.now - STUCK_MS);
  if (stuck.length) items.push({ code: "remindersStuck", severity: "serious", count: stuck.length, oldestDueAt: stuck[0].dueAt });
  for (const { tool, errorsToday: errors, callsToday: calls } of h.tools) {
    if (errors >= 3 && errors * 3 >= calls) items.push({ code: "toolErrors", severity: "warning", tool, errors, calls });
  }
  if (h.loginFailures >= 5) items.push({ code: "loginFailures", severity: "warning", count: h.loginFailures });
  if (h.accessRequests > 0) items.push({ code: "accessRequests", severity: "info", count: h.accessRequests });
  return items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}

// --- Helpers ---------------------------------------------------------------------------------------------------------

const statements = new Map<string, Database.Statement>();

/** A statement prepared on first use and reused by every refresh after it. */
function sql(source: string): Database.Statement {
  let statement = statements.get(source);
  if (!statement) {
    statement = db.prepare(source);
    statements.set(source, statement);
  }
  return statement;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Rows by key, in their order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(key(row));
    if (list) list.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}
