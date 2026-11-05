import type { RangeDays, Snapshot } from "../src/admin/types.js";

// A believable Snapshot for the view tests (and for looking at the page while working on it): a month of family use,
// a few groups, schedules, a login history. Made-up names and test numbers only. Deterministic: same input, same output.

const DAY = 86_400_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(ms);

export type FixtureOptions = { now?: number; range?: RangeDays; trouble?: boolean; empty?: boolean };

export function sampleSnapshot(opts: FixtureOptions = {}): Snapshot {
  const now = opts.now ?? Date.UTC(2026, 10, 5, 7, 42, 10); // Thu 5 Nov 2026, 14:42 in Jakarta
  const range = opts.range ?? 30;
  const rnd = random(range * 7 + (opts.trouble ? 1 : 0));
  const empty = opts.empty ?? false;
  const days = Array.from({ length: range }, (_, i) => dayOf(now - (range - 1 - i) * DAY));
  const people = [
    { number: "6281111111111", name: "Albert", weight: 0.42 },
    { number: "6282222222222", name: "Sarah", weight: 0.24 },
    { number: "6283333333333", name: "Budi", weight: 0.12 },
    { number: "6284444444444", name: "Rina", weight: 0.09 },
    { number: "6285555555555", name: "Dewi", weight: 0.06 },
    { number: "6286666666666", name: "Joko", weight: 0.04 },
    { number: "6287777777777", name: "Mama", weight: 0.03 },
  ];
  const daily = days.map((day, i) => {
    if (empty) return { day, dollars: 0, messages: 0, privateMessages: 0, groupMessages: 0, failed: 0, p50Ms: null, p95Ms: null, topPeople: [] };
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const base = (weekday === 0 || weekday === 6 ? 52 : 38) + Math.round(rnd() * 30);
    const isToday = i === days.length - 1;
    const messages = isToday ? Math.round(base * 0.62) : base;
    const groupMessages = Math.round(messages * (0.25 + rnd() * 0.2));
    const dollars = Number((messages * (0.021 + rnd() * 0.012)).toFixed(4));
    const p50 = 3800 + Math.round(rnd() * 2600);
    return {
      day,
      dollars,
      messages,
      privateMessages: messages - groupMessages,
      groupMessages,
      failed: opts.trouble && isToday ? 4 : rnd() > 0.85 ? 1 : 0,
      p50Ms: p50,
      p95Ms: p50 * (2.1 + rnd() * 1.4),
      topPeople: people.slice(0, 3).map((p) => ({ name: p.name, dollars: Number((dollars * p.weight * 1.6).toFixed(4)) })),
    };
  });
  const total = daily.reduce((a, d) => a + d.dollars, 0);
  const totalMessages = daily.reduce((a, d) => a + d.messages, 0);
  const today = daily.at(-1)!;
  const yesterday = daily.at(-2) ?? today;
  const heatmap = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      if (empty) return 0;
      const awake = h >= 6 && h <= 23 ? 1 : h <= 1 ? 0.3 : 0.04;
      const peak = Math.exp(-((h - 20) ** 2) / 10) * 1.4 + Math.exp(-((h - 12) ** 2) / 6) * 0.9 + Math.exp(-((h - 7) ** 2) / 3) * 0.6;
      const weekend = d >= 5 ? 1.25 : 1;
      return Math.round((awake * 2 + peak * 9) * weekend * (0.6 + rnd() * 0.8) * (range / 30));
    }),
  );
  const tools = empty
    ? []
    : [
        ["web_search", 312, 0, 0],
        ["create_reminder", 96, 0, 120],
        ["remember", 74, 0, 40],
        ["generate_image", 41, opts.trouble ? 5 : 1, 8200],
        ["google_calendar_events", 38, 0, 900],
        ["voice_note", 36, 0, 2400],
        ["create_document", 22, 0, 3100],
        ["market_analysis", 19, 2, 4400],
        ["send_message", 17, 0, 300],
        ["hevy_log_workout", 15, 0, 1100],
        ["create_poll", 12, 0, 500],
        ["web_fetch", 11, 1, 1800],
        ["spotify_create_playlist", 4, 0, 2100],
        ["edit_image", 3, 0, 9100],
      ].map(([tool, calls, errors, avgMs]) => ({
        tool: tool as string,
        calls: Math.round((calls as number) * (range / 30)) || 1,
        errors: errors as number,
        avgMs: avgMs as number,
      }));
  const personRows = people.map((p, i) => {
    const share = p.weight;
    return {
      number: p.number,
      name: p.name,
      admin: i === 0,
      source: (i < 2 ? "env" : "added") as "env" | "added",
      addedAt: i < 2 ? null : now - (40 - i * 4) * DAY,
      messagesToday: empty ? 0 : Math.round(today.messages * share),
      quotaToday: i === 0 || empty ? 0 : i === 2 ? 51 : Math.round(today.messages * share),
      messagesRange: empty ? 0 : Math.round(totalMessages * share),
      dollarsToday: empty ? 0 : today.dollars * share,
      dollarsMonth: empty ? 0 : total * share * 0.18,
      dollarsRange: empty ? 0 : total * share,
      lastActiveAt: empty || i === 6 ? null : now - [4, 38, 2.5 * 3600, 7 * 3600, 26 * 3600, 3 * DAY / 1000, 0][i] * 1000 * (i < 2 ? 60 : 1),
      links: { google: i <= 2, youtube: i === 0, hevy: i === 0 || i === 3, spotify: i === 1, shopeeShops: i === 0 ? 2 : 0 },
      ownModel: i === 1 ? "claude-sonnet-5-5" : null,
      style: i === 3 ? "chill" : null,
      can: { errands: i <= 1, onehub: i <= 1, smartlife: i === 0, switchModel: i <= 1 },
    };
  });
  const groups = [
    { chatId: "120363000000000001@g.us", name: "Keluarga Besar", members: 14, messages: 0.34 },
    { chatId: "120363000000000002@g.us", name: "Futsal Kamis", members: 11, messages: 0.21 },
    { chatId: "120363000000000003@g.us", name: "Kantor Onestop", members: 23, messages: 0.12 },
    { chatId: "120363000000000004@g.us", name: "Arisan RT 05", members: 31, messages: 0.03 },
  ].map((g, i) => ({
    chatId: g.chatId,
    name: g.name,
    members: g.members,
    inGroup: i !== 3 || !opts.trouble,
    messagesToday: empty ? 0 : Math.round(today.groupMessages * g.messages * 2),
    messagesRange: empty ? 0 : Math.round(totalMessages * g.messages * 0.6),
    lastActiveAt: empty ? null : now - [12, 95, 400, 9000][i] * 60_000,
    context: i === 0,
    paused: i === 2 ? { until: now + 90 * 60_000 } : null,
    model: i === 1 ? "claude-haiku-5-5" : null,
    style: i === 1 ? "funny" : null,
    schedules: [3, 1, 2, 0][i],
  }));
  const at = (minutes: number) => now + minutes * 60_000;
  const upcoming = empty
    ? []
    : [
        { id: 412, kind: "reminder" as const, dueAt: opts.trouble ? at(-45) : at(18), cron: null, where: "Albert", isGroup: false, owner: "Albert", text: "Bayar listrik dan internet" },
        { id: 377, kind: "task" as const, dueAt: at(138), cron: "0 17 * * 4", where: "Futsal Kamis", isGroup: true, owner: "Budi", text: "Buat polling siapa yang datang futsal malam ini" },
        { id: 390, kind: "reminder" as const, dueAt: at(260), cron: null, where: "Sarah", isGroup: false, owner: "Sarah", text: null },
        { id: 301, kind: "message" as const, dueAt: at(60 * 16 + 18), cron: "0 6 * * *", where: "Keluarga Besar", isGroup: true, owner: "Albert", text: "Selamat pagi semua ☀️ Jangan lupa sarapan ya" },
        { id: 355, kind: "task" as const, dueAt: at(60 * 17), cron: "0 7 * * 1-5", where: "Albert", isGroup: false, owner: "Albert", text: "Ringkasan berita hari ini dan cuaca Jakarta" },
        { id: 402, kind: "reminder" as const, dueAt: at(60 * 40), cron: "0 9 25 * *", where: "Rina", isGroup: false, owner: "Rina", text: null },
        { id: 288, kind: "message" as const, dueAt: at(60 * 90), cron: "0 8 * * 1", where: "Kantor Onestop", isGroup: true, owner: "Albert", text: "Jangan lupa setor laporan mingguan sebelum jam 12 ya 🙏" },
      ];
  const contacts = people.length;
  return {
    generatedAt: now,
    range,
    days,
    timezone: "Asia/Jakarta",
    botName: "Friday",
    adminName: "Albert",
    attention: opts.trouble
      ? [
          { code: "whatsappDown", severity: "critical", state: "closed", since: now - 7 * 60_000 },
          { code: "claudeFailing", severity: "serious", failures: 4, lastAt: now - 3 * 60_000, message: "overloaded_error: Overloaded" },
          { code: "remindersStuck", severity: "serious", count: 1, oldestDueAt: at(-45) },
          { code: "costToday", severity: "warning", dollars: 21.4, limit: 20 },
          { code: "backupStale", severity: "warning", lastAt: now - 50 * 3600_000 },
          { code: "accessRequests", severity: "info", count: 2 },
        ]
      : empty
        ? []
        : [{ code: "accessRequests", severity: "info", count: 2 }],
    status: {
      whatsapp: opts.trouble
        ? { state: "closed", since: now - 7 * 60_000, number: "6281775741000", reconnects: 3 }
        : { state: "open", since: now - (2 * DAY + 5 * 3600_000), number: "6281775741000", reconnects: 1 },
      stopped: false,
      lastTurnAt: empty ? null : now - 4 * 60_000,
      lastFailure: opts.trouble ? { at: now - 3 * 60_000, message: "overloaded_error: Overloaded" } : null,
      nextScheduleAt: upcoming.find((u) => u.dueAt > now)?.dueAt ?? null,
    },
    today: {
      day: today.day,
      dollars: opts.trouble ? 21.4 : today.dollars,
      messages: today.messages,
      failed: today.failed,
      refused: 0,
      people: empty ? 0 : 5,
      contacts,
      guests: empty ? 0 : 1,
      p50Ms: today.p50Ms,
      p95Ms: today.p95Ms,
      yesterday: { dollars: yesterday.dollars, messages: yesterday.messages },
    },
    month: empty
      ? { month: "2026-11", dollars: 0, projected: 0, previous: { month: "2026-10", dollars: 0, toDate: 0 } }
      : { month: "2026-11", dollars: 6.92, projected: 41.5, previous: { month: "2026-10", dollars: 38.12, toDate: 5.87 } },
    daily,
    costs: {
      total,
      people: empty ? [] : [...personRows].map((p) => ({ number: p.number, name: p.name, dollars: p.dollarsRange })).sort((a, b) => b.dollars - a.dollars),
      models: empty
        ? []
        : [
            { model: "claude-opus-5-5", dollars: total * 0.86, tokens: 41_200_000 },
            { model: "claude-sonnet-5-5", dollars: total * 0.11, tokens: 9_800_000 },
            { model: "claude-haiku-5-5", dollars: total * 0.03, tokens: 6_100_000 },
          ],
      tokens: empty
        ? { fresh: 0, cached: 0, output: 0, webSearches: 0, cacheSavings: 0, cacheShare: 0 }
        : { fresh: 6_420_000, cached: 48_900_000, output: 1_730_000, webSearches: Math.round(312 * (range / 30)), cacheSavings: total * 2.9, cacheShare: 0.884 },
    },
    activity: {
      total: totalMessages,
      failed: daily.reduce((a, d) => a + d.failed, 0),
      refused: empty ? 0 : 1,
      p50Ms: empty ? null : 4600,
      p95Ms: empty ? null : 14_200,
      heatmap,
      quietestHour: empty ? null : 3,
      busiestHour: empty ? null : 20,
      tools,
    },
    people: personRows,
    guests: empty
      ? []
      : [
          { number: "6289911112222", name: "Pak Herman", messagesRange: 14, dollarsRange: 0.41, lastActiveAt: now - 5 * 3600_000 },
          { number: "6289933334444", name: "Tante Lia", messagesRange: 6, dollarsRange: 0.17, lastActiveAt: now - 2 * DAY },
        ],
    accessRequests: empty
      ? []
      : [
          { number: "6281299990000", name: "Kevin", day: today.day },
          { number: "6285677778888", name: "Nadia Putri", day: yesterday.day },
        ],
    groups: empty ? [] : groups,
    schedules: {
      counts: empty ? { reminder: 0, message: 0, task: 0 } : { reminder: 14, message: 4, task: 3 },
      overdue: opts.trouble ? 1 : 0,
      upcoming,
    },
    integrations: {
      images: { provider: "cloudflare", today: opts.trouble ? 71 : 6, range: Math.round(44 * (range / 30)) },
      voice: { enabled: true, today: 3, range: Math.round(36 * (range / 30)) },
      google: { enabled: true, accounts: 3, youtube: 1 },
      hevy: { enabled: true, accounts: 2 },
      spotify: { enabled: true, accounts: 1 },
      shopee: { enabled: true, shops: 2, sandbox: true },
      smartlife: { enabled: true, users: 2 },
      onehub: { enabled: true, users: 2 },
      market: { today: 2, range: Math.round(19 * (range / 30)) },
      polls: { range: Math.round(12 * (range / 30)) },
      groupWorkouts: { active: 0, range: 2 },
      groupContext: { groups: 1 },
      errands: {
        users: 2,
        active: 1,
        last24h: 1,
        dailyLimit: 10,
        recent: empty
          ? []
          : [
              { id: 41, requester: "Albert", target: "Sate Senayan", status: "active", turns: 4, updatedAt: now - 35 * 60_000 },
              { id: 40, requester: "Sarah", target: "Toko Sepatu Melati", status: "done", turns: 7, updatedAt: now - 26 * 3600_000 },
              { id: 39, requester: "Albert", target: "Bengkel Jaya Motor", status: "expired", turns: 2, updatedAt: now - 5 * DAY },
            ],
      },
    },
    settings: {
      model: "claude-opus-5-5",
      effort: "medium",
      chatModels: 2,
      dailyMessageLimit: 50,
      groupAccess: "everyone",
      sessionIdleHours: 1,
      sessionMaxTokens: 40_000,
      usdToIdr: 16_500,
      alertTotal: 20,
      alertPerson: 5,
      publicUrl: "https://fridayai.my.id",
    },
    system: {
      startedAt: now - (2 * DAY + 5 * 3600_000 + 12 * 60_000),
      uptimeMs: 2 * DAY + 5 * 3600_000 + 12 * 60_000,
      version: { hash: "c6f25cb", date: "05-11-2026" },
      node: "v22.23.4",
      memory: { rss: opts.trouble ? 352 * 1024 ** 2 : 168 * 1024 ** 2, heapUsed: 71 * 1024 ** 2, heapTotal: 96 * 1024 ** 2, limit: 400 * 1024 ** 2 },
      host: { load: [0.42, 0.37, 0.31], cpus: 2, memFree: 512 * 1024 ** 2, memTotal: 1946 * 1024 ** 2, uptimeMs: 41 * DAY },
      storage: { db: 18.4 * 1024 ** 2, images: 212 * 1024 ** 2, imagesCount: 386, disk: { free: 21.7 * 1024 ** 3, total: 58 * 1024 ** 3 } },
      backups: opts.trouble
        ? { dir: "/opt/friday/backups", found: true, count: 14, latestAt: now - 50 * 3600_000, latestBytes: 9.1 * 1024 ** 2, totalBytes: 121 * 1024 ** 2 }
        : { dir: "/opt/friday/backups", found: true, count: 14, latestAt: now - 11 * 3600_000 - 12 * 60_000, latestBytes: 9.4 * 1024 ** 2, totalBytes: 126 * 1024 ** 2 },
    },
    connection: opts.trouble
      ? [
          { at: now - 7 * 60_000, state: "closed", detail: "408" },
          { at: now - 40 * 3600_000, state: "open", detail: "6281775741000" },
          { at: now - 40 * 3600_000 - 9000, state: "closed", detail: "515" },
          { at: now - 2 * DAY, state: "open", detail: "6281775741000" },
          { at: now - 2 * DAY - 4000, state: "connecting" },
        ]
      : [
          { at: now - 40 * 3600_000, state: "open", detail: "6281775741000" },
          { at: now - 40 * 3600_000 - 9000, state: "closed", detail: "515" },
          { at: now - 2 * DAY, state: "open", detail: "6281775741000" },
          { at: now - 2 * DAY - 4000, state: "connecting" },
        ],
    problems: opts.trouble
      ? [
          { at: now - 3 * 60_000, level: "error", text: "[Futsal Kamis] turn failed InternalServerError: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}" },
          { at: now - 9 * 60_000, level: "warn", text: "task #377: skipped a run that was 74 minutes late" },
          { at: now - 2 * 3600_000, level: "error", text: "Couldn't read a vote in poll #88" },
          { at: now - 30 * 3600_000, level: "warn", text: "Couldn't look up the newest fable model: Connection error." },
        ]
      : [{ at: now - 30 * 3600_000, level: "warn", text: "Couldn't look up the newest fable model: Connection error." }],
    security: {
      sessions: [
        { current: true, createdAt: now - 26 * 3600_000, seenAt: now, expiresAt: now + 7 * DAY, ip: "182.253.10.44", agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
        { current: false, createdAt: now - 3 * DAY, seenAt: now - 5 * 3600_000, expiresAt: now + 6 * DAY, ip: "114.124.211.9", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" },
      ],
      logins: [
        { at: now - 26 * 3600_000, ip: "182.253.10.44", agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36", result: "ok" },
        ...(opts.trouble
          ? [
              { at: now - 30 * 3600_000, ip: "45.141.84.120", agent: "python-requests/2.32", result: "blocked" as const },
              { at: now - 30 * 3600_000 - 60_000, ip: "45.141.84.120", agent: "python-requests/2.32", result: "wrong" as const },
            ]
          : []),
        { at: now - 3 * DAY, ip: "114.124.211.9", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile/15E148 Safari/604.1", result: "ok" },
        { at: now - 3 * DAY - 40_000, ip: "114.124.211.9", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile/15E148 Safari/604.1", result: "wrong" },
      ],
      failures24h: opts.trouble ? 6 : 0,
    },
  };
}
