import type { Problem } from "../logging.js";
import type { ConnectionEvent, WhatsAppState, WhatsAppStatus } from "../monitor.js";

// The dashboard at PUBLIC_URL/admin, in three parts that meet here:
//   data.ts   builds a Snapshot from the database and the running process (read-only, cheap enough to run every 30 s)
//   view.ts   turns a Snapshot into HTML (no database access, no I/O)
//   server.ts handles the requests: sign-in, sessions, the few actions, assets, and calls the other two
//
// Times are epoch milliseconds; days are "YYYY-MM-DD" in config.TIMEZONE; money is estimated US dollars (list prices,
// like /usage); durations are milliseconds. Nothing in a Snapshot is what someone wrote to Friday, except the text of
// schedules the admin may already see (their own, and those posted in groups).

export type RangeDays = 7 | 30 | 90;
export const RANGES: readonly RangeDays[] = [7, 30, 90];

/** Page sections, also their #anchors. */
export const SECTIONS = ["ringkasan", "biaya", "aktivitas", "orang", "grup", "jadwal", "fitur", "sistem", "keamanan"] as const;
export type Section = (typeof SECTIONS)[number];

export type Severity = "info" | "warning" | "serious" | "critical";

/** Something the admin should look at, worst first. The view writes the words; the data says what and how bad. */
export type Attention =
  /** WhatsApp isn't connected (Friday reconnects by itself; loggedOut/waitingForScan need a new link). */
  | { code: "whatsappDown"; severity: "critical"; state: Exclude<WhatsAppState, "open">; since: number }
  /** /stop is on: Friday ignores every chat. */
  | { code: "stopped"; severity: "warning" }
  /** Claude turns failed in the last hour. critical when no turn succeeded since the first failure. */
  | { code: "claudeFailing"; severity: "serious" | "critical"; failures: number; lastAt: number; message: string }
  | { code: "costToday"; severity: "warning"; dollars: number; limit: number }
  | { code: "costPerson"; severity: "warning"; name: string; dollars: number; limit: number }
  /** used/limit: the process's memory against the service's cap. serious from 90%. */
  | { code: "memoryHigh"; severity: "warning" | "serious"; used: number; limit: number }
  /** serious below 5% free. */
  | { code: "diskLow"; severity: "warning" | "serious"; free: number; total: number }
  /** The backup folder exists but its newest backup is over 36 hours old (lastAt null: none in it). */
  | { code: "backupStale"; severity: "warning"; lastAt: number | null }
  /** Active schedules due more than 10 minutes ago that haven't gone out. */
  | { code: "remindersStuck"; severity: "serious"; count: number; oldestDueAt: number }
  /** A tool failing often today (at least 3 errors and at least a third of its calls). */
  | { code: "toolErrors"; severity: "warning"; tool: string; errors: number; calls: number }
  /** Wrong or blocked dashboard sign-ins in the last 24 hours (shown from 5). */
  | { code: "loginFailures"; severity: "warning"; count: number }
  /** People who asked for access from the website and aren't contacts yet. */
  | { code: "accessRequests"; severity: "info"; count: number };

export type DayStat = {
  day: string;
  dollars: number;
  /** Answered messages (turns, any outcome); group = chats ending in @g.us, private = everything else. */
  messages: number;
  privateMessages: number;
  groupMessages: number;
  failed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Who cost the most that day, at most 3. */
  topPeople: { name: string; dollars: number }[];
};

/** tool: the Claude tool name ("web_search" for searches Claude ran itself, "voice_note" for transcriptions). */
export type ToolStat = { tool: string; calls: number; errors: number; avgMs: number };

export type PersonRow = {
  number: string;
  name: string;
  admin: boolean;
  /** env = ALLOWED_CONTACTS in .env, added = /add over WhatsApp. */
  source: "env" | "added";
  addedAt: number | null;
  messagesToday: number;
  /** Messages counted against DAILY_MESSAGE_LIMIT today (the `usage` table; the admin has no limit, so 0). */
  quotaToday: number;
  messagesRange: number;
  dollarsToday: number;
  dollarsMonth: number;
  dollarsRange: number;
  lastActiveAt: number | null;
  links: { google: boolean; youtube: boolean; hevy: boolean; spotify: boolean; shopeeShops: number };
  /** Model and style of their private chat, when not the default. */
  ownModel: string | null;
  style: string | null;
  can: { errands: boolean; onehub: boolean; smartlife: boolean; switchModel: boolean };
};

/** Someone who isn't a contact but used Friday in a group during the range. */
export type GuestRow = { number: string; name: string; messagesRange: number; dollarsRange: number; lastActiveAt: number | null };

export type GroupRow = {
  chatId: string;
  name: string;
  /** Members besides Friday, when WhatsApp said. */
  members: number | null;
  /** Friday is still in it (from WhatsApp's list); false when it's only known from history. */
  inGroup: boolean;
  messagesToday: number;
  messagesRange: number;
  lastActiveAt: number | null;
  context: boolean;
  /** null: not paused. until null: paused until the admin wakes it. */
  paused: { until: number | null } | null;
  model: string | null;
  style: string | null;
  schedules: number;
};

export type ScheduleRow = {
  id: number;
  kind: "reminder" | "message" | "task";
  dueAt: number;
  cron: string | null;
  /** Chat it goes to: the group's name, or the person's. */
  where: string;
  isGroup: boolean;
  /** Who set it up. */
  owner: string;
  /** null when it's someone else's private schedule. */
  text: string | null;
};

export type ErrandRow = { id: number; requester: string; target: string; status: string; turns: number; updatedAt: number };

export type Snapshot = {
  generatedAt: number;
  range: RangeDays;
  /** The range's days, oldest first, ending today. */
  days: string[];
  timezone: string;
  botName: string;
  adminName: string;
  attention: Attention[];

  status: {
    whatsapp: WhatsAppStatus;
    stopped: boolean;
    lastTurnAt: number | null;
    lastFailure: { at: number; message: string } | null;
    nextScheduleAt: number | null;
  };

  today: {
    day: string;
    dollars: number;
    messages: number;
    failed: number;
    refused: number;
    /** Distinct people who got an answer today, and how many contacts there are. */
    people: number;
    contacts: number;
    p50Ms: number | null;
    p95Ms: number | null;
    yesterday: { dollars: number; messages: number };
  };

  month: {
    month: string;
    dollars: number;
    /** This month's pace carried to its last day. */
    projected: number;
    previous: { month: string; dollars: number; toDate: number };
  };

  /** One per day of the range. */
  daily: DayStat[];

  costs: {
    total: number;
    people: { number: string; name: string; dollars: number }[];
    models: { model: string; dollars: number; tokens: number }[];
    /** fresh = input + cache writes; cached = cache reads; cacheSavings = dollars cache reads saved versus fresh input. */
    tokens: { fresh: number; cached: number; output: number; webSearches: number; cacheSavings: number; cacheShare: number };
  };

  activity: {
    total: number;
    failed: number;
    refused: number;
    p50Ms: number | null;
    p95Ms: number | null;
    /** [weekday: 0 = Monday … 6 = Sunday][hour 0–23], local time. */
    heatmap: number[][];
    quietestHour: number | null;
    busiestHour: number | null;
    tools: ToolStat[];
  };

  people: PersonRow[];
  guests: GuestRow[];
  accessRequests: { number: string; name: string; day: string }[];
  groups: GroupRow[];

  schedules: {
    counts: { reminder: number; message: number; task: number };
    overdue: number;
    /** The next ones, soonest first, at most 30. */
    upcoming: ScheduleRow[];
  };

  integrations: {
    images: { provider: "cloudflare" | "gemini" | null; today: number; range: number };
    voice: { enabled: boolean; today: number; range: number };
    google: { enabled: boolean; accounts: number; youtube: number };
    hevy: { enabled: boolean; accounts: number };
    spotify: { enabled: boolean; accounts: number };
    shopee: { enabled: boolean; shops: number; sandbox: boolean };
    smartlife: { enabled: boolean; users: number };
    onehub: { enabled: boolean; users: number };
    market: { today: number; range: number };
    polls: { range: number };
    groupWorkouts: { active: number; range: number };
    groupContext: { groups: number };
    errands: { users: number; active: number; today: number; dailyLimit: number; recent: ErrandRow[] };
  };

  settings: {
    model: string;
    effort: string;
    chatModels: number;
    dailyMessageLimit: number;
    groupAccess: string;
    sessionIdleHours: number;
    sessionMaxTokens: number;
    usdToIdr: number;
    alertTotal: number;
    alertPerson: number;
    publicUrl: string;
  };

  system: {
    startedAt: number;
    uptimeMs: number;
    version: { hash: string; date: string } | null;
    node: string;
    memory: { rss: number; heapUsed: number; heapTotal: number; limit: number | null };
    host: { load: [number, number, number]; cpus: number; memFree: number; memTotal: number; uptimeMs: number };
    storage: { db: number; images: number; imagesCount: number; disk: { free: number; total: number } | null };
    backups: { dir: string; found: boolean; count: number; latestAt: number | null; latestBytes: number | null; totalBytes: number };
  };

  /** Newest first, since Friday started (kept in memory). */
  connection: ConnectionEvent[];
  problems: Problem[];

  security: {
    sessions: { current: boolean; createdAt: number; seenAt: number; expiresAt: number; ip: string; agent: string }[];
    /** Newest first, at most 30. */
    logins: { at: number; ip: string; agent: string; result: "ok" | "wrong" | "blocked" }[];
    failures24h: number;
  };
};

// What server.ts hands view.ts besides the Snapshot.

/** A note after an action, from ?done=… on the redirect. */
export type Flash = "stopped" | "resumed" | "woke" | "signedOutOthers";
export const FLASHES: readonly Flash[] = ["stopped", "resumed", "woke", "signedOutOthers"];

/** POST /admin/action, field `action` (wake also sends `chat`, the group's chat id). */
export type AdminAction = "stop" | "resume" | "wake" | "signOutOthers";
export const ACTIONS: readonly AdminAction[] = ["stop", "resume", "wake", "signOutOthers"];

/** asset("dashboard.css") → "/admin/assets/dashboard.css?v=<hash>". */
export type AssetUrl = (file: string) => string;

export type ViewContext = { csrf: string; range: RangeDays; flash?: Flash; asset: AssetUrl };

export type LoginProblem = "wrong" | "blocked" | "expired" | "origin" | "unconfigured";
export type LoginView = { problem?: LoginProblem; username?: string; retryAfterMs?: number; asset: AssetUrl };
