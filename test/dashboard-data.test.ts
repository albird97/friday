import "./dashboard-env.js";
import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { snapshot, type SnapshotOptions } from "../src/admin/data.js";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { config } from "../src/config.js";
import { addContact, takeDailyQuota } from "../src/contacts.js";
import { db } from "../src/db.js";
import { setContext } from "../src/groupcontext.js";
import { setChatModel } from "../src/model.js";
import { noteWhatsApp, pruneMonitor, recordTool, recordTurn, startedAt, whatsappStatus, type Outcome } from "../src/monitor.js";
import { EVERYWHERE, pause } from "../src/pause.js";
import { saveSession } from "../src/session.js";
import { setStyle } from "../src/styles.js";
import type { Outbox } from "../src/types.js";
import { recordUsage, type Usage } from "../src/usage.js";

// The dashboard's data layer, against a real (temporary) database seeded through Friday's own functions, at a fixed
// moment: Thursday 5 November 2026, 10:00 in Jakarta.

const NOW = Date.parse("2026-11-05T10:00:00+07:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const jakarta = (local: string) => Date.parse(`${local}+07:00`);

type Person = { name: string; number: string };
const BUDI: Person = { name: "Budi", number: "6283333333333" }; // added over WhatsApp; a Smart Life user (dashboard-env.ts)
const DODI: Person = { name: "Dodi", number: "6285555555555" }; // not a contact: talks to Friday in a group
const BOT = "6280000000000";
const [G1, G2, G3, G4, G5, G6] = [1, 2, 3, 4, 5, 6].map((n) => `12036300000000000${n}@g.us`);
const chatOf = (who: Person) => `${who.number}@s.whatsapp.net`;

const view = (opts: Partial<SnapshotOptions> = {}) => snapshot({ range: 7, now: NOW, ...opts });
const cents = (n: number) => Math.round(n * 100) / 100;

function turn(who: Person, chatId: string, chatName: string, local: string, ms: number, outcome: Outcome = "ok", error?: unknown) {
  recordTurn({ at: jakarta(local), chatId, chatName, number: who.number, name: who.name, ms, outcome }, error);
}

const NO_TOKENS: Usage = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, webSearches: 0 };
function spent(who: Person, local: string, usage: Partial<Usage>, model = "claude-opus-5-5") {
  recordUsage(who, model, { ...NO_TOKENS, ...usage }, new Date(jakarta(local)));
}

function reminder(r: { chatId: string; by: string; text: string; dueAt: number; kind?: string; cron?: string; chatName?: string; active?: number }) {
  db.prepare("INSERT INTO reminders (chat_id, created_by, text, due_at, cron, kind, chat_name, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    r.chatId,
    r.by,
    r.text,
    r.dueAt,
    r.cron ?? null,
    r.kind ?? "reminder",
    r.chatName ?? null,
    r.active ?? 1,
    NOW - DAY,
  );
}

// What's on disk is read once a minute at most, so it's all in place before the first snapshot. The fake backups go
// wherever the test setup pointed BACKUP_DIR, as long as that's a temp folder, never a real one.
const BACKUP_DIR = config.BACKUP_DIR;
assert.ok(BACKUP_DIR.startsWith(os.tmpdir()), `BACKUP_DIR ${BACKUP_DIR} isn't a temp folder`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
for (const [name, bytes, mtime] of [
  ["friday-2026-11-03.tar.gz", 100, NOW - 2 * DAY],
  ["friday-2026-11-04.tar.gz", 200, NOW - DAY],
  ["friday-2026-11-05.tar.gz", 300, NOW - 2 * HOUR],
] as const) {
  const file = path.join(BACKUP_DIR, name);
  fs.writeFileSync(file, Buffer.alloc(bytes));
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}
fs.writeFileSync(path.join(BACKUP_DIR, "notes.txt"), "not a backup");
fs.mkdirSync(path.join(BACKUP_DIR, "friday-folder.tar.gz"));
fs.writeFileSync(path.join(config.DATA_DIR, "images", "1.png"), Buffer.alloc(10));
fs.writeFileSync(path.join(config.DATA_DIR, "images", "2.jpg"), Buffer.alloc(20));

const TABLES = [
  "turns", "tool_usage", "token_usage", "usage", "contacts", "access_requests", "reminders", "sessions", "pauses", "chat_styles", "settings",
  "google_accounts", "google_youtube", "hevy_accounts", "spotify_accounts", "shopee_shops", "polls", "group_workouts", "errands",
  "admin_sessions", "admin_logins",
];

before(() => noteWhatsApp("open", BOT)); // otherwise "still connecting" would join every attention list
beforeEach(() => {
  for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
  claude.reset();
});

describe("dashboard days", () => {
  it("are the range's dates in Jakarta, ending today", async () => {
    // 00:30 on 1 March in Jakarta is still 28 February in UTC.
    const march = await view({ now: Date.parse("2026-03-01T00:30:00+07:00") });
    assert.deepEqual(march.days, ["2026-02-23", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01"]);
    assert.equal(march.today.day, "2026-03-01");
    assert.deepEqual([march.month.month, march.month.previous.month], ["2026-03", "2026-02"]);

    const month = await view({ range: 30 });
    assert.equal(month.days.length, 30);
    assert.deepEqual([month.days[0], month.days.at(-1)], ["2026-10-07", "2026-11-05"]);
    assert.equal((await view({ range: 90 })).days[0], "2026-08-08");
    assert.deepEqual([month.timezone, month.botName, month.adminName, month.range], ["Asia/Jakarta", config.BOT_NAME, ADMIN.name, 30]);
  });
});

describe("dashboard money", () => {
  function seedSpending() {
    spent(ADMIN, "2026-11-05T08:00:00", { output: 100_000, webSearches: 3 }); // $2.03
    spent(WIFE, "2026-11-05T09:00:00", { output: 50_000 }); // $1
    spent(DODI, "2026-11-05T09:30:00", { output: 25_000 }); // $0.50
    spent(ADMIN, "2026-11-04T20:00:00", { output: 100_000 }, "claude-sonnet-5-5"); // $1
    spent(WIFE, "2026-11-01T12:00:00", { input: 1_000_000, cacheRead: 1_000_000 }); // $4 + $0.20
    spent(ADMIN, "2026-10-30T12:00:00", { output: 50_000 }); // $1, the range's first day
    spent(ADMIN, "2026-10-29T12:00:00", { output: 150_000 }); // $3, last month, before the range
    spent(ADMIN, "2026-10-03T12:00:00", { output: 200_000 }); // $4, last month up to the 5th
    spent(WIFE, "2026-10-05T12:00:00", { output: 25_000 }); // $0.50, last month on the 5th itself
    spent(WIFE, "2026-10-06T12:00:00", { output: 50_000 }); // $1, last month after the 5th
    spent(ADMIN, "2026-09-30T12:00:00", { output: 500_000 }); // $10, too long ago
  }

  it("adds up each day, with who cost the most", async () => {
    seedSpending();
    const s = await view();
    assert.deepEqual(
      s.daily.map((d) => [d.day, cents(d.dollars)]),
      [["2026-10-30", 1], ["2026-10-31", 0], ["2026-11-01", 4.2], ["2026-11-02", 0], ["2026-11-03", 0], ["2026-11-04", 1], ["2026-11-05", 3.53]],
    );
    const today = s.daily.at(-1)!;
    assert.deepEqual(today.topPeople.map((p) => [p.name, cents(p.dollars)]), [["Albert", 2.03], ["Sarah", 1], ["Dodi", 0.5]]);
    assert.deepEqual(s.daily[1].topPeople, []);
    assert.deepEqual([cents(s.today.dollars), cents(s.today.yesterday.dollars)], [3.53, 1]);
  });

  it("projects this month from its pace and sets it against last month to the same date", async () => {
    seedSpending();
    const { month } = await view();
    assert.equal(month.month, "2026-11");
    assert.equal(cents(month.dollars), 8.73);
    assert.equal(cents(month.projected), 59.3); // $8.73 in 4 days and 10 hours, carried to 30 days
    // Up to 10:00 on 5 October: the $4 of the 3rd, and 10/24 of the 5th's $0.50.
    assert.deepEqual([month.previous.month, cents(month.previous.dollars), cents(month.previous.toDate)], ["2026-10", 9.5, 4.21]);
  });

  it("counts only the part of today that has passed", async () => {
    spent(ADMIN, "2026-10-01T12:00:00", { output: 200_000 }); // $4 on the 1st of last month
    spent(ADMIN, "2026-10-02T12:00:00", { output: 100_000 }); // $2 on the 2nd
    spent(ADMIN, "2026-11-01T05:00:00", { output: 50_000 }); // $1 this morning
    const early = await view({ now: jakarta("2026-11-01T06:00:00") });
    // At 06:00 the month is a quarter of a day old, counted as the half day minimum; last month to date is a quarter of 1 October's $4.
    assert.deepEqual([cents(early.month.projected), cents(early.month.previous.toDate), cents(early.month.previous.dollars)], [60, 1, 6]);
    const evening = await view({ now: jakarta("2026-11-01T18:00:00") });
    assert.deepEqual([cents(evening.month.projected), cents(evening.month.previous.toDate)], [40, 3]);
  });

  it("compares a short previous month in full", async () => {
    spent(ADMIN, "2026-02-10T12:00:00", { output: 50_000 });
    spent(ADMIN, "2026-02-28T12:00:00", { output: 100_000 });
    spent(ADMIN, "2026-03-31T09:00:00", { output: 50_000 });
    const end = await view({ now: jakarta("2026-03-31T10:00:00") });
    assert.deepEqual([cents(end.month.previous.dollars), cents(end.month.previous.toDate), cents(end.month.projected)], [3, 3, 1.02]);
    const mid = await view({ now: jakarta("2026-03-15T10:00:00") });
    assert.equal(cents(mid.month.previous.toDate), 1);
  });

  it("breaks the range's cost down by person, model and kind of token", async () => {
    seedSpending();
    const { costs } = await view();
    assert.equal(cents(costs.total), 9.73);
    assert.deepEqual(costs.people.map((p) => [p.number, p.name, cents(p.dollars)]), [
      [WIFE.number, "Sarah", 5.2],
      [ADMIN.number, "Albert", 4.03],
      [DODI.number, "Dodi", 0.5],
    ]);
    assert.deepEqual(costs.models.map((m) => [m.model, cents(m.dollars), m.tokens]), [
      ["claude-opus-5-5", 8.73, 2_225_000],
      ["claude-sonnet-5-5", 1, 100_000],
    ]);
    assert.deepEqual({ ...costs.tokens, cacheSavings: cents(costs.tokens.cacheSavings) }, {
      fresh: 1_000_000,
      cached: 1_000_000,
      output: 325_000,
      webSearches: 3,
      cacheSavings: 3.8, // a million cached tokens at $0.20 instead of $4
      cacheShare: 0.5,
    });
  });
});

describe("dashboard messages", () => {
  function seedTurns() {
    turn(ADMIN, "errand:3", "errand #3 Resto", "2026-11-05T07:00:00", 8000);
    turn(ADMIN, chatOf(ADMIN), "Albert", "2026-11-05T08:15:00", 2000);
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:00:00", 4000);
    turn(WIFE, G1, "Keluarga", "2026-11-05T09:30:00", 6000);
    turn(DODI, G1, "Keluarga", "2026-11-05T09:45:00", 30_000, "failed");
    turn(ADMIN, chatOf(ADMIN), "Albert", "2026-11-05T09:50:00", 1000, "refused");
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-04T20:00:00", 3000);
    turn(ADMIN, G1, "Keluarga", "2026-11-04T21:00:00", 5000);
    turn(ADMIN, chatOf(ADMIN), "Albert", "2026-11-02T00:10:00", 1000); // Monday just after midnight: Sunday in UTC
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-01T23:30:00", 2000);
    turn(BUDI, chatOf(BUDI), "Budi", "2026-10-20T10:00:00", 1000); // before the range
  }

  it("counts every answered message per day, private and group, with answer times of the good ones", async () => {
    seedTurns();
    const s = await view();
    const [today, yesterday] = [s.daily.at(-1)!, s.daily.at(-2)!];
    assert.deepEqual(
      { ...today, dollars: 0, topPeople: [] },
      { day: "2026-11-05", dollars: 0, messages: 6, privateMessages: 4, groupMessages: 2, failed: 1, p50Ms: 4000, p95Ms: 8000, topPeople: [] },
    );
    assert.deepEqual([yesterday.messages, yesterday.privateMessages, yesterday.groupMessages, yesterday.p50Ms, yesterday.p95Ms], [2, 1, 1, 3000, 5000]);
    assert.deepEqual(
      s.daily.map((d) => d.messages),
      [0, 0, 1, 1, 0, 2, 6],
    );
    assert.equal(s.daily[0].p50Ms, null);

    const { day, dollars, ...rest } = s.today;
    // Albert and Sarah of the 2 contacts, and Dodi in the group.
    assert.deepEqual(rest, { messages: 6, failed: 1, refused: 1, people: 2, contacts: 2, guests: 1, p50Ms: 4000, p95Ms: 8000, yesterday: { dollars: 0, messages: 2 } });
    // Eight good answers in the range: 1, 2, 2, 3, 4, 5, 6 and 8 seconds.
    assert.deepEqual([s.activity.total, s.activity.failed, s.activity.refused, s.activity.p50Ms, s.activity.p95Ms], [10, 1, 1, 3000, 8000]);
  });

  it("places the heatmap in Jakarta time, Monday first", async () => {
    seedTurns();
    const { activity } = await view();
    const cells = activity.heatmap.flatMap((hours, weekday) => hours.flatMap((n, hour) => (n ? [[weekday, hour, n]] : [])));
    assert.deepEqual(cells, [
      [0, 0, 1], // Monday 00:10
      [2, 20, 1],
      [2, 21, 1],
      [3, 7, 1], // Thursday
      [3, 8, 1],
      [3, 9, 4],
      [6, 23, 1], // Sunday 23:30
    ]);
    assert.equal(activity.heatmap.length, 7);
    assert.ok(activity.heatmap.every((hours) => hours.length === 24));
    assert.equal(activity.busiestHour, 9);
    assert.equal(activity.quietestHour, 1, "the earliest of the hours with nothing");
  });

  it("has no quietest or busiest hour without messages", async () => {
    const { activity } = await view();
    assert.deepEqual([activity.quietestHour, activity.busiestHour, activity.p50Ms, activity.total], [null, null, null, 0]);
  });

  it("knows when Friday last answered well", async () => {
    seedTurns();
    const s = await view();
    assert.equal(s.status.lastTurnAt, jakarta("2026-11-05T09:30:00") + 6000, "the latest end of a good answer");
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:20:00", 20 * MINUTE); // started earlier, ended later
    assert.equal((await view()).status.lastTurnAt, jakarta("2026-11-05T09:40:00"));
  });

  it("lists tool calls, with Claude's own web searches added to them", async () => {
    const today = new Date(NOW - HOUR);
    recordTool("remember", true, 100, today);
    recordTool("remember", true, 300, today);
    recordTool("remember", false, 200, new Date(NOW - 2 * DAY));
    recordTool("web_search", true, 900, today);
    recordTool("voice_note", true, 1500, new Date(NOW - 10 * DAY)); // before the range
    spent(ADMIN, "2026-11-05T08:00:00", { output: 1000, webSearches: 4 });
    spent(WIFE, "2026-11-03T08:00:00", { output: 1000, webSearches: 1 });
    const { activity } = await view();
    assert.deepEqual(activity.tools, [
      { tool: "web_search", calls: 6, errors: 0, avgMs: 900 },
      { tool: "remember", calls: 3, errors: 1, avgMs: 200 },
    ]);
  });
});

describe("dashboard people", () => {
  it("describes each contact: quota, spending, links, roles, own model and style", async () => {
    addContact(BUDI.name, BUDI.number);
    takeDailyQuota(WIFE.number, "2026-11-05");
    takeDailyQuota(WIFE.number, "2026-11-05");
    takeDailyQuota(WIFE.number, "2026-11-04");
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:00:00", 4000);
    turn(WIFE, G1, "Keluarga", "2026-11-03T09:00:00", 4000);
    turn(BUDI, chatOf(BUDI), "Budi", "2026-10-20T10:00:00", 1000);
    spent(WIFE, "2026-11-05T09:00:00", { output: 50_000 });
    spent(WIFE, "2026-11-02T09:00:00", { output: 100_000 });
    spent(WIFE, "2026-10-29T09:00:00", { output: 100_000 });
    const link = (table: string, columns: string, number: string, ...values: unknown[]) =>
      db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => "?").join(", ")}, ?)`).run(...values, number);
    link("google_accounts", "email, refresh_token, scopes, connected_at, number", ADMIN.number, "albert@example.com", "google-refresh-secret", "[]", NOW);
    link("google_youtube", "refresh_token, connected_at, number", ADMIN.number, "youtube-refresh-secret", NOW);
    link("hevy_accounts", "name, api_key, connected_at, number", WIFE.number, "sarah", "hevy-key-secret", NOW);
    link("spotify_accounts", "spotify_id, name, refresh_token, connected_at, number", WIFE.number, "sarah-sp", "Sarah", "spotify-refresh-secret", NOW);
    for (const shop of ["1001", "1002"]) {
      link("shopee_shops", "shop_id, name, access_token, access_expires, refresh_token, connected_at, number", WIFE.number, shop, `Toko ${shop}`, "shopee-access-secret", NOW, "shopee-refresh-secret", NOW);
    }
    setChatModel(chatOf(WIFE), "claude-haiku-5-5");
    setStyle(chatOf(WIFE), "Sarah", "formal");

    const s = await view();
    const [albert, sarah, budi] = s.people;
    assert.deepEqual(s.people.map((p) => p.name), ["Albert", "Sarah", "Budi"]);
    assert.deepEqual(
      { admin: albert.admin, source: albert.source, addedAt: albert.addedAt, quota: albert.quotaToday, ownModel: albert.ownModel, style: albert.style },
      { admin: true, source: "env", addedAt: null, quota: 0, ownModel: null, style: null },
    );
    assert.deepEqual(albert.links, { google: true, youtube: true, hevy: false, spotify: false, shopeeShops: 0 });
    assert.deepEqual(albert.can, { errands: false, onehub: true, smartlife: true, switchModel: true });

    assert.deepEqual(
      {
        today: sarah.messagesToday,
        quota: sarah.quotaToday,
        range: sarah.messagesRange,
        lastActiveAt: sarah.lastActiveAt,
        dollars: [sarah.dollarsToday, sarah.dollarsMonth, sarah.dollarsRange].map(cents),
        ownModel: sarah.ownModel,
        style: sarah.style,
      },
      { today: 1, quota: 2, range: 2, lastActiveAt: jakarta("2026-11-05T09:00:00"), dollars: [1, 3, 3], ownModel: "claude-haiku-5-5", style: "formal" },
    );
    assert.deepEqual(sarah.links, { google: false, youtube: false, hevy: true, spotify: true, shopeeShops: 2 });
    assert.deepEqual(sarah.can, { errands: true, onehub: false, smartlife: false, switchModel: true });

    assert.equal(budi.source, "added");
    assert.ok(budi.addedAt && Math.abs(budi.addedAt - Date.now()) < MINUTE);
    assert.deepEqual([budi.messagesRange, budi.lastActiveAt], [0, jakarta("2026-10-20T10:00:00")], "last active even before the range");
    assert.deepEqual(budi.can, { errands: false, onehub: false, smartlife: true, switchModel: false });
    assert.equal(s.today.contacts, 3);

    assert.doesNotMatch(JSON.stringify(s), /secret|albert@example\.com/, "no tokens, keys or addresses");
  });

  it("finds a person's own model, style and schedules in a chat WhatsApp names by LID", async () => {
    const LID = "201234567890123@lid"; // how Baileys 7 often names a 1:1 chat, instead of by number
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-01T09:00:00", 1000);
    turn(WIFE, LID, "Sarah", "2026-11-05T09:00:00", 1000); // her latest
    turn(WIFE, G1, "Keluarga", "2026-11-05T09:30:00", 1000);
    turn(ADMIN, "cli", "terminal", "2026-11-05T09:40:00", 1000);
    turn(ADMIN, "errand:3", "errand #3 Resto", "2026-11-05T09:45:00", 1000);
    setChatModel(chatOf(WIFE), "claude-sonnet-5-5");
    setChatModel(LID, "claude-haiku-5-5");
    setStyle(chatOf(WIFE), "Sarah", "formal");
    setChatModel("cli", "claude-haiku-5-5"); // the terminal's, not Albert's own chat's
    setChatModel("errand:3", "claude-haiku-5-5");
    reminder({ chatId: LID, by: WIFE.number, text: "Rahasia Sarah", dueAt: NOW + HOUR });
    reminder({ chatId: "209999999999999@lid", by: "6289999999999", text: "Orang lain", dueAt: NOW + 2 * HOUR }); // no turn there
    reminder({ chatId: "6289999999999@s.whatsapp.net", by: "6289999999999", text: "Orang lain juga", dueAt: NOW + 3 * HOUR });

    const s = await view();
    const [albert, sarah] = s.people;
    assert.deepEqual([sarah.ownModel, sarah.style], ["claude-haiku-5-5", "formal"], "the latest chat's model; the style of the chat that has one");
    assert.deepEqual([albert.ownModel, albert.style], [null, null]);
    assert.deepEqual(
      s.schedules.upcoming.map((r) => [r.where, r.isGroup, r.text]),
      [["Sarah", false, null], ["chat pribadi", false, null], ["+6289999999999", false, null]],
    );
  });

  it("lists guests from groups, and the last 30 days' access requests from people who aren't contacts yet", async () => {
    addContact(BUDI.name, BUDI.number);
    const GINA: Person = { name: "Gina", number: "6286000000003" }; // a contact once, removed since
    turn(DODI, G1, "Keluarga", "2026-11-05T09:45:00", 3000);
    turn(DODI, G1, "Keluarga", "2026-11-04T09:45:00", 3000);
    turn({ name: "Eko", number: "6286000000001" }, G1, "Keluarga", "2026-10-01T09:45:00", 3000); // before the range
    turn(GINA, chatOf(GINA), "Gina", "2026-11-05T08:00:00", 3000);
    spent(DODI, "2026-11-05T09:45:00", { output: 25_000 });
    spent(GINA, "2026-11-05T08:00:00", { output: 50_000 });
    spent({ name: "Fani", number: "6286000000002" }, "2026-11-03T09:45:00", { output: 50_000 }); // tokens, no turn in a group
    turn(WIFE, G1, "Keluarga", "2026-11-05T09:00:00", 3000);
    const ask = db.prepare("INSERT INTO access_requests (number, name, day) VALUES (?, ?, ?)");
    ask.run("6287000000001", "Rina", "2026-11-04");
    ask.run(BUDI.number, "Budi", "2026-11-03"); // added since
    ask.run("6287000000002", "Tono", "2026-11-05");
    ask.run("6287000000003", "Wati", "2026-10-07"); // 29 days ago: still on the list
    ask.run("6287000000004", "Yuni", "2026-10-06"); // 30 days ago: no longer

    const s = await view();
    assert.deepEqual(
      s.guests.map((g) => ({ ...g, dollarsRange: cents(g.dollarsRange) })),
      [{ number: DODI.number, name: "Dodi", messagesRange: 2, dollarsRange: 0.5, lastActiveAt: jakarta("2026-11-05T09:45:00") }],
    );
    assert.deepEqual([s.today.people, s.today.contacts, s.today.guests], [1, 3, 1], "Sarah; Dodi in the group; Gina in neither");
    assert.deepEqual(s.accessRequests, [
      { number: "6287000000002", name: "Tono", day: "2026-11-05" },
      { number: "6287000000001", name: "Rina", day: "2026-11-04" },
      { number: "6287000000003", name: "Wati", day: "2026-10-07" },
    ]);
    assert.deepEqual(s.attention.at(-1), { code: "accessRequests", severity: "info", count: 3 });
  });
});

describe("dashboard groups", () => {
  function seedGroups() {
    turn(WIFE, G1, "Keluarga", "2026-11-05T09:30:00", 3000);
    turn(ADMIN, G3, "Arisan Lama", "2026-11-03T19:00:00", 3000);
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:00:00", 3000);
    saveSession(G4, { system: "", messages: [], tokens: 0, updatedAt: NOW });
    pause(G2, "Futsal", null);
    setStyle(G5, "Kantor", "chill");
    setStyle(chatOf(WIFE), "Sarah", "formal");
    reminder({ chatId: G6, by: ADMIN.number, text: "Reuni bulan depan", dueAt: NOW + DAY, chatName: "Reuni SMA" });
    setContext(G1, true);
    setChatModel(G2, "claude-sonnet-5-5");
  }
  const whatsapp = (): Outbox => ({
    async sendText() {},
    async sendFile() {},
    async sendImage() {},
    async typing() {},
    chatIdFor: (n) => `${n}@s.whatsapp.net`,
    groups: async () => [
      { id: G1, name: "Keluarga Besar", size: 5 },
      { id: G2, name: "Futsal", size: 12 },
    ],
  });

  it("joins WhatsApp's list with every group Friday has a trace of, busiest first", async () => {
    seedGroups();
    const { groups } = await view({ outbox: whatsapp() });
    assert.deepEqual(groups, [
      { chatId: G1, name: "Keluarga Besar", members: 5, inGroup: true, messagesToday: 1, messagesRange: 1, lastActiveAt: jakarta("2026-11-05T09:30:00"), context: true, paused: null, model: null, style: null, schedules: 0 },
      { chatId: G3, name: "Arisan Lama", members: null, inGroup: false, messagesToday: 0, messagesRange: 1, lastActiveAt: jakarta("2026-11-03T19:00:00"), context: false, paused: null, model: null, style: null, schedules: 0 },
      { chatId: G2, name: "Futsal", members: 12, inGroup: true, messagesToday: 0, messagesRange: 0, lastActiveAt: null, context: false, paused: { until: null }, model: "claude-sonnet-5-5", style: null, schedules: 0 },
      { chatId: G4, name: "Grup tanpa nama", members: null, inGroup: false, messagesToday: 0, messagesRange: 0, lastActiveAt: null, context: false, paused: null, model: null, style: null, schedules: 0 },
      { chatId: G5, name: "Kantor", members: null, inGroup: false, messagesToday: 0, messagesRange: 0, lastActiveAt: null, context: false, paused: null, model: null, style: "chill", schedules: 0 },
      { chatId: G6, name: "Reuni SMA", members: null, inGroup: false, messagesToday: 0, messagesRange: 0, lastActiveAt: null, context: false, paused: null, model: null, style: null, schedules: 1 },
    ]);
  });

  it("assumes Friday is still in every group until WhatsApp has listed them", async () => {
    seedGroups();
    const { groups } = await view();
    assert.equal(groups.length, 6);
    assert.ok(groups.every((g) => g.inGroup && g.members === null));
    assert.equal(groups.find((g) => g.chatId === G1)?.name, "Keluarga", "the name from its latest message");
  });

  it("keeps the last list while WhatsApp is slow, waiting about 3 seconds at most", async () => {
    seedGroups();
    let calls = 0;
    const outbox: Outbox = { ...whatsapp(), groups: () => (++calls === 1 ? whatsapp().groups!() : new Promise(() => {})) };
    await view({ outbox });
    const started = performance.now();
    const stale = await view({ outbox, now: NOW + 11 * MINUTE });
    const waited = performance.now() - started;
    assert.ok(waited > 2900 && waited < 4500, `waited ${Math.round(waited)} ms`);
    assert.equal(stale.groups.find((g) => g.chatId === G1)?.name, "Keluarga Besar");
    assert.equal(stale.groups.find((g) => g.chatId === G3)?.inGroup, false);

    const again = performance.now();
    await view({ outbox, now: NOW + 12 * MINUTE });
    assert.ok(performance.now() - again < 1000, "a refresh already under way isn't waited for twice");
    assert.equal(calls, 2);
  });

  it("takes an empty list for no answer while Friday is known to be in groups", async (t) => {
    seedGroups();
    const warn = t.mock.method(console, "warn", () => {});
    let calls = 0;
    // Baileys resolves [] when WhatsApp doesn't answer in time.
    const outbox: Outbox = { ...whatsapp(), groups: () => (++calls === 1 ? whatsapp().groups!() : Promise.resolve([])) };
    await view({ outbox });
    const empty = await view({ outbox, now: NOW + 11 * MINUTE });
    assert.equal(calls, 2);
    assert.deepEqual(empty.groups.filter((g) => g.inGroup).map((g) => [g.name, g.members]), [["Keluarga Besar", 5], ["Futsal", 12]], "the last list stays");
    await view({ outbox, now: NOW + 11 * MINUTE + 30_000 });
    assert.equal(calls, 2, "tried again after a minute, as after a failure");
    await view({ outbox, now: NOW + 12 * MINUTE + 1000 });
    assert.equal(calls, 3);
    assert.equal(warn.mock.callCount(), 1, "once per outage");

    const never: Outbox = { ...whatsapp(), groups: async () => [] };
    assert.ok((await view({ outbox: never })).groups.every((g) => g.inGroup), "never listed, but known from history: assumed");
  });

  it("believes an empty list when Friday isn't known to be in any group", async () => {
    let calls = 0;
    const outbox: Outbox = { ...whatsapp(), groups: async () => (calls++, []) };
    assert.deepEqual((await view({ outbox })).groups, []);
    await view({ outbox, now: NOW + 5 * MINUTE });
    assert.equal(calls, 1, "fresh for 10 minutes, like any list");
  });

  it("never fails over WhatsApp's list, and says so once per outage", async () => {
    seedGroups();
    let calls = 0;
    const outbox: Outbox = {
      ...whatsapp(),
      groups: async () => {
        calls++;
        throw new Error("Connection Closed");
      },
    };
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const s = await view({ outbox });
      assert.ok(s.groups.every((g) => g.inGroup), "never listed, so assumed");
      await view({ outbox, now: NOW + 30_000 });
      assert.equal(calls, 1, "retried after a minute, not on every refresh");
      await view({ outbox, now: NOW + 61_000 });
      assert.equal(calls, 2);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].join(" ")), /Connection Closed/);
  });
});

describe("dashboard schedules", () => {
  it("shows the text only of the admin's own schedules and of groups'", async () => {
    turn(WIFE, G1, "Keluarga", "2026-11-05T09:30:00", 3000);
    reminder({ chatId: chatOf(ADMIN), by: ADMIN.number, text: "Bayar listrik", dueAt: NOW + HOUR });
    reminder({ chatId: chatOf(WIFE), by: WIFE.number, text: "Rahasia Sarah", dueAt: NOW + 2 * HOUR });
    reminder({ chatId: G1, by: WIFE.number, text: "Selamat pagi semua", dueAt: NOW + 3 * HOUR, kind: "message" });
    reminder({ chatId: G2, by: ADMIN.number, text: "Kirim polling futsal", dueAt: NOW + DAY, kind: "task", cron: "0 7 * * 4", chatName: "Futsal Kamis" });
    reminder({ chatId: chatOf(WIFE), by: WIFE.number, text: "Minum obat", dueAt: NOW - 20 * MINUTE });
    reminder({ chatId: chatOf(WIFE), by: WIFE.number, text: "Sudah lewat", dueAt: NOW - DAY, active: 0 });
    reminder({ chatId: "6289999999999@s.whatsapp.net", by: "6289999999999", text: "Orang lain", dueAt: NOW + 4 * HOUR });
    reminder({ chatId: chatOf(WIFE), by: ADMIN.number, text: "Jemput Albert", dueAt: NOW + 5 * HOUR });

    const s = await view();
    assert.deepEqual(
      s.schedules.upcoming.map(({ id, ...r }) => r),
      [
        { kind: "reminder", dueAt: NOW - 20 * MINUTE, cron: null, where: "Sarah", isGroup: false, owner: "Sarah", text: null },
        { kind: "reminder", dueAt: NOW + HOUR, cron: null, where: "Albert", isGroup: false, owner: "Albert", text: "Bayar listrik" },
        { kind: "reminder", dueAt: NOW + 2 * HOUR, cron: null, where: "Sarah", isGroup: false, owner: "Sarah", text: null },
        { kind: "message", dueAt: NOW + 3 * HOUR, cron: null, where: "Keluarga", isGroup: true, owner: "Sarah", text: "Selamat pagi semua" },
        { kind: "reminder", dueAt: NOW + 4 * HOUR, cron: null, where: "+6289999999999", isGroup: false, owner: "+6289999999999", text: null },
        { kind: "reminder", dueAt: NOW + 5 * HOUR, cron: null, where: "Sarah", isGroup: false, owner: "Albert", text: "Jemput Albert" },
        { kind: "task", dueAt: NOW + DAY, cron: "0 7 * * 4", where: "Futsal Kamis", isGroup: true, owner: "Albert", text: "Kirim polling futsal" },
      ],
    );
    assert.deepEqual(s.schedules.counts, { reminder: 5, message: 1, task: 1 });
    assert.equal(s.schedules.overdue, 1);
    assert.equal(s.status.nextScheduleAt, NOW + HOUR);
    assert.deepEqual(s.attention.find((a) => a.code === "remindersStuck"), { code: "remindersStuck", severity: "serious", count: 1, oldestDueAt: NOW - 20 * MINUTE });
    assert.deepEqual(s.groups.map((g) => [g.chatId, g.schedules]), [[G1, 1], [G2, 1]]);
    assert.doesNotMatch(JSON.stringify(s), /Rahasia Sarah|Minum obat|Orang lain/);
  });

  it("keeps only the next 30", async () => {
    for (let i = 0; i < 35; i++) reminder({ chatId: chatOf(ADMIN), by: ADMIN.number, text: `#${i}`, dueAt: NOW + (35 - i) * HOUR });
    const { schedules } = await view();
    assert.equal(schedules.upcoming.length, 30);
    assert.equal(schedules.counts.reminder, 35);
    assert.deepEqual([schedules.upcoming[0].text, schedules.upcoming[29].text], ["#34", "#5"]);
  });
});

describe("dashboard attention", () => {
  it("raises what needs a look, worst first", async () => {
    pause(EVERYWHERE, "Semua chat", null);
    spent(ADMIN, "2026-11-05T08:00:00", { output: 150_000 }); // $3: the total's limit and Albert's
    spent(WIFE, "2026-11-05T08:00:00", { output: 50_000 }); // $1: under hers
    reminder({ chatId: chatOf(ADMIN), by: ADMIN.number, text: "Telat", dueAt: NOW - 15 * MINUTE });
    reminder({ chatId: chatOf(ADMIN), by: ADMIN.number, text: "Baru saja", dueAt: NOW - 5 * MINUTE }); // not stuck yet
    const today = new Date(NOW - HOUR);
    for (const ok of [false, false, false, true, true]) recordTool("generate_image", ok, 500, today);
    for (const ok of [false, false, false, true, true, true, true, true, true, true, true, true]) recordTool("spotify_search", ok, 500, today);
    for (const ok of [false, false, false]) recordTool("edit_image", ok, 500, new Date(NOW - DAY)); // yesterday
    db.prepare("INSERT INTO access_requests (number, name, day) VALUES (?, ?, ?)").run("6287000000001", "Rina", "2026-11-04");
    const login = db.prepare("INSERT INTO admin_logins (at, ip, agent, result) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 4; i++) login.run(NOW - (i + 1) * HOUR, "203.0.113.9", "curl", "wrong");
    login.run(NOW - 2 * HOUR, "203.0.113.9", "curl", "blocked");
    login.run(NOW - 2 * DAY, "203.0.113.9", "curl", "wrong");
    login.run(NOW - MINUTE, "203.0.113.5", "Safari", "ok");

    const s = await view();
    const shown = s.attention.filter((a) => a.code !== "memoryHigh" && a.code !== "diskLow"); // those depend on this machine
    assert.deepEqual(shown, [
      { code: "remindersStuck", severity: "serious", count: 1, oldestDueAt: NOW - 15 * MINUTE },
      { code: "stopped", severity: "warning" },
      { code: "costToday", severity: "warning", dollars: 4, limit: 3 },
      { code: "costPerson", severity: "warning", name: "Albert", dollars: 3, limit: 2 },
      { code: "toolErrors", severity: "warning", tool: "generate_image", errors: 3, calls: 5 },
      { code: "loginFailures", severity: "warning", count: 5 },
      { code: "accessRequests", severity: "info", count: 1 },
    ]);
    assert.equal(s.status.stopped, true);
    assert.equal(s.security.failures24h, 5);
  });

  it("calls Claude failing critical until an answer goes through again", async () => {
    turn(ADMIN, chatOf(ADMIN), "Albert", "2026-11-05T07:30:00", 1000, "failed", new Error("too old to count"));
    turn(ADMIN, chatOf(ADMIN), "Albert", "2026-11-05T09:20:00", 2000);
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:30:00", 20_000, "failed", new Error("first"));
    turn(DODI, G1, "Keluarga", "2026-11-05T09:50:00", 15_000, "failed", new Error("529 Overloaded"));
    const failing = (await view()).attention.find((a) => a.code === "claudeFailing");
    assert.deepEqual(failing, { code: "claudeFailing", severity: "critical", failures: 2, lastAt: jakarta("2026-11-05T09:50:15"), message: "Error: 529 Overloaded" });

    turn(WIFE, chatOf(WIFE), "Sarah", "2026-11-05T09:55:00", 3000);
    const s = await view();
    assert.equal(s.attention.find((a) => a.code === "claudeFailing")?.severity, "serious");
    assert.deepEqual(s.status.lastFailure, { at: jakarta("2026-11-05T09:50:15"), message: "Error: 529 Overloaded" });
    assert.equal((await view({ now: NOW + 2 * HOUR })).attention.find((a) => a.code === "claudeFailing"), undefined, "over an hour ago");
  });

  it("calls WhatsApp down at once when it needs a new link, otherwise after a minute", async () => {
    try {
      noteWhatsApp("waitingForScan");
      const scan = whatsappStatus().since;
      assert.deepEqual((await view({ now: scan + 1000 })).attention[0], { code: "whatsappDown", severity: "critical", state: "waitingForScan", since: scan });

      noteWhatsApp("closed", "428");
      const closed = whatsappStatus().since;
      assert.equal(closed, scan, "still down since the link was lost");
      const down = (s: { attention: { code: string }[] }) => s.attention.some((a) => a.code === "whatsappDown");
      assert.equal(down(await view({ now: closed + 30_000 })), false, "reconnecting by itself");
      assert.equal(down(await view({ now: closed + 61_000 })), true);
    } finally {
      noteWhatsApp("open", BOT);
    }
    const s = await view({ now: Date.now() });
    assert.equal(s.attention.some((a) => a.code === "whatsappDown"), false);
    assert.equal(s.status.whatsapp.state, "open");
    assert.deepEqual(
      s.connection.slice(0, 3).map((e) => [e.state, e.detail]),
      [["open", BOT], ["closed", "428"], ["waitingForScan", undefined]],
    );
  });

  it("keeps WhatsApp down since the first drop while it keeps trying to reconnect", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    try {
      noteWhatsApp("closed", "408");
      // whatsapp.ts tries again 3 seconds after each close, and each try soon closes again.
      for (let flip = 1; flip <= 200; flip++) {
        t.mock.timers.tick(3000);
        if (flip % 2) noteWhatsApp("connecting");
        else noteWhatsApp("closed", "408");
      }
      assert.equal(Date.now(), NOW + 10 * MINUTE);
      const s = await view({ now: Date.now() });
      assert.deepEqual(s.attention.find((a) => a.code === "whatsappDown"), { code: "whatsappDown", severity: "critical", state: "closed", since: NOW });
      assert.equal(s.status.whatsapp.since, NOW);
      t.mock.timers.tick(3000);
      noteWhatsApp("connecting");
      noteWhatsApp("open", BOT);
      assert.equal(whatsappStatus().since, NOW + 10 * MINUTE + 3000, "open since it connected again");
    } finally {
      if (whatsappStatus().state !== "open") noteWhatsApp("open", BOT);
    }
  });

  it("notices when the newest backup is over 36 hours old", async () => {
    assert.equal((await view()).attention.some((a) => a.code === "backupStale"), false);
    const late = await view({ now: NOW + 40 * HOUR });
    assert.deepEqual(late.attention.find((a) => a.code === "backupStale"), { code: "backupStale", severity: "warning", lastAt: NOW - 2 * HOUR });
  });
});

describe("dashboard machine", () => {
  it("finds the backups and what's on disk", async () => {
    const { system } = await view({ now: startedAt + 5000 });
    assert.deepEqual(system.backups, { dir: BACKUP_DIR, found: true, count: 3, latestAt: NOW - 2 * HOUR, latestBytes: 300, totalBytes: 600 });
    assert.deepEqual([system.storage.images, system.storage.imagesCount], [30, 2]);
    assert.ok(system.storage.db > 0);
    assert.ok(system.storage.disk && system.storage.disk.free <= system.storage.disk.total);
    assert.deepEqual([system.startedAt, system.uptimeMs, system.node], [startedAt, 5000, process.version]);
    assert.ok(system.version === null || (/^[0-9a-f]{7,}$/.test(system.version.hash) && /^\d{4}-\d{2}-\d{2}$/.test(system.version.date)));
    assert.ok(system.memory.rss > 0 && system.memory.heapUsed > 0);
    if (process.platform !== "linux") assert.equal(system.memory.limit, null);
    assert.equal(system.host.load.length, 3);
    assert.ok(system.host.cpus > 0 && system.host.memFree <= system.host.memTotal);
  });
});

describe("dashboard security", () => {
  it("shows sign-in sessions without their ids or CSRF tokens", async () => {
    const session = db.prepare("INSERT INTO admin_sessions (id, csrf, credential, created_at, seen_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    session.run("session-hash-this", "csrf-token-this", "credential-print", NOW - 2 * HOUR, NOW - MINUTE, NOW + 7 * DAY, "203.0.113.5", "Safari iPhone");
    session.run("session-hash-other", "csrf-token-other", "credential-print", NOW - 3 * DAY, NOW - HOUR, NOW + 4 * DAY, "198.51.100.7", "Firefox");
    session.run("session-hash-gone", "csrf-token-gone", "credential-print", NOW - 9 * DAY, NOW - 8 * DAY, NOW - MINUTE, "198.51.100.8", "Chrome");
    const login = db.prepare("INSERT INTO admin_logins (at, ip, agent, result) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 35; i++) login.run(NOW - (35 - i) * HOUR, "203.0.113.5", "Safari iPhone", i % 7 ? "ok" : "wrong");

    const { security } = await view({ currentSession: "session-hash-this" });
    assert.deepEqual(security.sessions, [
      { current: true, createdAt: NOW - 2 * HOUR, seenAt: NOW - MINUTE, expiresAt: NOW + 7 * DAY, ip: "203.0.113.5", agent: "Safari iPhone" },
      { current: false, createdAt: NOW - 3 * DAY, seenAt: NOW - HOUR, expiresAt: NOW + 4 * DAY, ip: "198.51.100.7", agent: "Firefox" },
    ]);
    assert.equal(security.logins.length, 30);
    assert.deepEqual(security.logins[0], { at: NOW - HOUR, ip: "203.0.113.5", agent: "Safari iPhone", result: "ok" });
    assert.equal(security.logins.at(-1)!.at, NOW - 30 * HOUR);
    assert.equal(security.failures24h, 3, "wrong ones within a day: the 14th, 21st and 28th of 35");

    const all = JSON.stringify(await view());
    assert.doesNotMatch(all, /session-hash|csrf-token|credential-print/);
    assert.ok((await view()).security.sessions.every((s) => !s.current), "no current session when none is given");
  });
});

describe("dashboard features and settings", () => {
  it("counts what each feature did, and how it's set up", async () => {
    const today = new Date(NOW - HOUR);
    recordTool("generate_image", true, 4000, today);
    recordTool("generate_image", true, 4000, today);
    recordTool("edit_image", true, 4000, new Date(NOW - DAY));
    for (const ok of [true, true, false]) recordTool("voice_note", ok, 1500, today);
    recordTool("market_analysis", true, 9000, today);
    const poll = db.prepare("INSERT INTO polls (msg_id, chat_id, question, options, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    poll.run("m1", G1, "Makan di mana?", "[]", "", ADMIN.number, NOW - DAY);
    poll.run("m2", G1, "Jam berapa?", "[]", "", ADMIN.number, NOW - 2 * DAY);
    poll.run("m3", G1, "Lama", "[]", "", ADMIN.number, NOW - 10 * DAY);
    const workout = db.prepare("INSERT INTO group_workouts (host, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    workout.run(ADMIN.number, "Leg day", "inviting", NOW - HOUR, NOW - HOUR);
    workout.run(ADMIN.number, "Push", "active", NOW - 2 * DAY, NOW - DAY);
    workout.run(ADMIN.number, "Pull", "finished", NOW - 3 * DAY, NOW - 3 * DAY);
    workout.run(ADMIN.number, "Lama", "cancelled", NOW - 20 * DAY, NOW - 20 * DAY);
    setContext(G1, true);
    setContext(G2, true);
    setChatModel(G1, "claude-haiku-5-5");
    setChatModel(chatOf(WIFE), "claude-haiku-5-5");
    const errand = db.prepare(
      `INSERT INTO errands (requester_number, requester_chat, requester_name, target_number, target_chat, target_name, goal, first_message, code, status, turns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'secret goal', 'secret first message', 'secret-code', ?, ?, ?, ?)`,
    );
    const statuses = ["done", "pending", "active", "done", "cancelled", "expired", "active", "done", "done", "done", "done", "done"];
    statuses.forEach((status, i) =>
      errand.run(WIFE.number, chatOf(WIFE), "Sarah", `628700000010${i % 10}`, "x", `Resto ${i}`, status, i, NOW - (12 - i) * HOUR - DAY, NOW - (12 - i) * MINUTE),
    );
    errand.run(WIFE.number, chatOf(WIFE), "Sarah", "6287000000200", "x", "Resto baru", "done", 2, NOW - HOUR, NOW - 30_000);

    const s = await view();
    const { errands, ...features } = s.integrations;
    assert.deepEqual(features, {
      images: { provider: "cloudflare", today: 2, range: 3 },
      voice: { enabled: true, today: 3, range: 3 },
      google: { enabled: true, accounts: 0, youtube: 0 },
      hevy: { enabled: true, accounts: 0 },
      spotify: { enabled: true, accounts: 0 },
      shopee: { enabled: true, shops: 0, sandbox: false },
      smartlife: { enabled: true, users: 2 },
      onehub: { enabled: false, users: 1 },
      market: { today: 1, range: 1 },
      polls: { range: 2 },
      groupWorkouts: { active: 2, range: 3 },
      groupContext: { groups: 2 },
    });
    assert.deepEqual([errands.users, errands.active, errands.last24h, errands.dailyLimit], [1, 3, 1, config.ERRAND_DAILY_LIMIT]);
    assert.equal(errands.recent.length, 10);
    assert.deepEqual(errands.recent[0], { id: errands.recent[0].id, requester: "Sarah", target: "Resto baru", status: "done", turns: 2, updatedAt: NOW - 30_000 });
    assert.deepEqual(errands.recent.slice(1).map((e) => e.target), ["Resto 11", "Resto 10", "Resto 9", "Resto 8", "Resto 7", "Resto 6", "Resto 5", "Resto 4", "Resto 3"]);
    assert.doesNotMatch(JSON.stringify(s), /secret/);

    assert.deepEqual(s.settings, {
      model: config.FRIDAY_MODEL,
      effort: config.FRIDAY_EFFORT,
      chatModels: 2,
      dailyMessageLimit: 3,
      groupAccess: "everyone",
      sessionIdleHours: config.SESSION_IDLE_HOURS,
      sessionMaxTokens: config.SESSION_MAX_TOKENS,
      usdToIdr: config.USD_TO_IDR,
      alertTotal: 3,
      alertPerson: 2,
      publicUrl: "https://friday.test",
    });
  });

  it("counts errands active only while they take replies, and new ones in the last 24 hours", async () => {
    const errand = db.prepare(
      `INSERT INTO errands (requester_number, requester_chat, requester_name, target_number, target_chat, target_name, goal, first_message, code, status, turns, created_at, updated_at)
       VALUES (?, ?, 'Sarah', '6287000000100', 'x', ?, 'goal', 'first message', '', ?, 1, ?, ?)`,
    );
    const add = (target: string, status: string, createdAt: number, updatedAt: number) => errand.run(WIFE.number, chatOf(WIFE), target, status, createdAt, updatedAt);
    add("Resto", "active", NOW - 2 * HOUR, NOW - HOUR);
    add("Toko", "done", NOW - 12 * HOUR, NOW - 11 * HOUR); // 22:00 yesterday: within 24 hours
    add("Bengkel", "pending", NOW - 30 * HOUR, NOW - 30 * HOUR);
    add("Salon", "active", NOW - 5 * DAY, NOW - 3 * DAY - MINUTE); // silent for over 3 days: takes no more replies
    add("Apotek", "pending", NOW - 6 * DAY, NOW - 4 * DAY);

    const { errands } = (await view()).integrations;
    assert.deepEqual([errands.active, errands.last24h], [2, 2]);
    assert.deepEqual(errands.recent.map((e) => [e.target, e.status]), [["Resto", "active"], ["Toko", "done"], ["Bengkel", "pending"], ["Salon", "expired"], ["Apotek", "pending"]]);
  });
});

describe("dashboard recording", () => {
  let sent: { chatId: string; text?: string }[] = [];
  const outbox: Outbox = {
    async sendText(chatId, text) {
      sent.push({ chatId, text });
    },
    async sendFile() {},
    async sendImage() {},
    async typing() {},
    chatIdFor: (n) => `${n}@s.whatsapp.net`,
  };
  const dm = (from: Person, text: string): Incoming => ({
    chat: { chatId: chatOf(from), isGroup: false, chatName: from.name, sender: { ...from, isContact: true } },
    text,
    addressed: true,
  });

  it("records each answered message and tool call as it happens", async () => {
    sent = [];
    claude.replies.push(
      { content: [{ type: "tool_use", id: "tu_1", name: "remember", input: { fact: "Albert suka kopi tanpa gula" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Siap, sudah kuingat." }], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "Ingat ya, aku suka kopi tanpa gula"), outbox);
    assert.equal(sent.at(-1)?.text, "Siap, sudah kuingat.");

    assert.deepEqual(db.prepare("SELECT chat_id AS chatId, chat_name AS chatName, number, name, outcome FROM turns").all(), [
      { chatId: chatOf(ADMIN), chatName: "Albert", number: ADMIN.number, name: "Albert", outcome: "ok" },
    ]);
    assert.deepEqual(db.prepare("SELECT tool, calls, errors FROM tool_usage").all(), [{ tool: "remember", calls: 1, errors: 0 }]);

    const s = await snapshot({ range: 7 });
    assert.deepEqual([s.today.messages, s.today.people], [1, 1]);
    assert.deepEqual(s.activity.tools.map((t) => [t.tool, t.calls, t.errors]), [["remember", 1, 0]]);
    assert.ok(s.status.lastTurnAt && s.status.lastTurnAt <= Date.now());
    assert.ok(s.today.dollars > 0, "the fake API's tokens are priced");
  });
});

describe("dashboard records", () => {
  it("keeps who used Friday, and what it cost, 180 days at most", () => {
    // 180 days before 10:00 on 5 November is 10:00 on 9 May.
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-05-09T09:00:00", 1000);
    turn(WIFE, chatOf(WIFE), "Sarah", "2026-05-09T11:00:00", 1000);
    for (const day of ["2026-05-08", "2026-05-09", "2026-11-05"]) {
      spent(WIFE, `${day}T12:00:00`, { output: 1000 });
      takeDailyQuota(WIFE.number, day);
    }
    recordTool("remember", true, 100, new Date(jakarta("2026-05-08T12:00:00"))); // tool counts aren't anyone's: 400 days

    pruneMonitor(NOW);
    const days = (table: string) => (db.prepare(`SELECT day FROM ${table} ORDER BY day`).all() as { day: string }[]).map((r) => r.day);
    assert.deepEqual(days("turns"), ["2026-05-09"]);
    assert.deepEqual(db.prepare("SELECT at FROM turns").all(), [{ at: jakarta("2026-05-09T11:00:00") }]);
    assert.deepEqual(days("token_usage"), ["2026-05-09", "2026-11-05"]);
    assert.deepEqual(days("usage"), ["2026-05-09", "2026-11-05"]);
    assert.deepEqual(days("tool_usage"), ["2026-05-08"]);
  });
});
