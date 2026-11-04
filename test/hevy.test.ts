import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { decrypt } from "../src/google.js";
import { findExercises, forgetCatalog, matchScore, type Template } from "../src/hevy.js";
import { confirmHevy, hevyNotes, hevyTools } from "../src/hevyapps.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";

// Hevy itself, faked: one account per API key, holding exercises, workouts, routines, folders and measurements.

const KEYS = { sarah: "11111111-2222-4333-8444-555555555555", albert: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revoked: "99999999-9999-4999-8999-999999999999" };

const BUILT_IN: Template[] = [
  { id: "D04AC939", title: "Bench Press (Barbell)", type: "weight_reps", primary_muscle_group: "chest" },
  { id: "3601968B", title: "Bench Press (Dumbbell)", type: "weight_reps", primary_muscle_group: "chest" },
  { id: "6A6C31A5", title: "Lat Pulldown (Cable)", type: "weight_reps", primary_muscle_group: "lats" },
  { id: "1B2B1E7C", title: "Pull Up", type: "bodyweight_reps", primary_muscle_group: "lats" },
  { id: "ABCD0001", title: "Bicep Curl (Dumbbell)", type: "weight_reps", primary_muscle_group: "biceps" },
  { id: "C6272009", title: "Plank", type: "duration", primary_muscle_group: "abdominals" },
  { id: "RUN00001", title: "Running", type: "distance_duration", primary_muscle_group: "cardio" },
  // Enough of these that the exercise list takes two pages.
  ...Array.from({ length: 110 }, (_, i) => ({ id: `F${i}`, title: `Filler Move ${i} (Machine)`, type: "weight_reps", primary_muscle_group: "other" })),
];

type Account = { name: string; templates: Template[]; workouts: any[]; routines: any[]; folders: any[]; measurements: any[] };
let accounts: Record<string, Account>;
type Call = { method: string; path: string; key: string | null; body: any };
let calls: Call[];
let sent: { chatId: string; text: string; quote?: unknown }[];
let nextId = 1;

function resetHevy() {
  const account = (name: string): Account => ({ name, templates: [...BUILT_IN], workouts: [], routines: [], folders: [], measurements: [] });
  accounts = { [KEYS.sarah]: account("sarah_lifts"), [KEYS.albert]: account("albert") };
  calls = [];
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const page = (items: unknown[], key: string, q: URLSearchParams, max: number) => {
  const size = Math.min(Number(q.get("pageSize") ?? 5), max);
  const n = Number(q.get("page") ?? 1);
  const count = Math.max(1, Math.ceil(items.length / size));
  if (n > count) return json({ error: "Page not found" }, 404);
  return json({ page: n, page_count: count, [key]: items.slice((n - 1) * size, n * size) });
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.hevyapp.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const key = new Headers(init?.headers).get("api-key");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push({ method, path, key, body });
  const a = key ? accounts[key] : undefined;
  if (!a) return json({ error: "Unauthorized" }, 401);
  const q = url.searchParams;
  const [, kind, id] = path.split("/");
  if (path === "/user/info") return json({ data: { id: "u1", name: a.name, url: `https://hevy.com/user/${a.name}` } });
  if (path === "/workouts/count") return json({ workout_count: a.workouts.length });
  if (kind === "exercise_templates" && method === "GET") return page(a.templates, "exercise_templates", q, 100);
  if (kind === "exercise_templates" && method === "POST") {
    const t = { id: `C${nextId++}`, title: body.exercise.title, type: body.exercise.exercise_type, primary_muscle_group: body.exercise.muscle_group, is_custom: true };
    a.templates.push(t);
    return json({ id: t.id });
  }
  const titled = (exercises: any[]) =>
    exercises.map((e: any, i: number) => ({ index: i, title: a.templates.find((t) => t.id === e.exercise_template_id)?.title, exercise_template_id: e.exercise_template_id, supersets_id: e.superset_id, notes: e.notes, rest_seconds: e.rest_seconds, sets: e.sets.map((s: any, j: number) => ({ index: j, ...s })) }));
  if (kind === "workouts" && !id && method === "GET") return page([...a.workouts].sort((x, y) => Date.parse(y.start_time) - Date.parse(x.start_time)), "workouts", q, 10);
  if (kind === "workouts" && method === "POST") {
    const w = { id: `w${nextId++}`, ...body.workout, exercises: titled(body.workout.exercises) };
    delete w.is_private; // Hevy never shows it back
    a.workouts.push(w);
    return json({ workout: [w] }, 201);
  }
  if (kind === "workouts" && id) {
    const i = a.workouts.findIndex((w) => w.id === id);
    if (i < 0) return json({ error: "Workout not found" }, 404);
    if (method === "PUT") {
      if (typeof body.workout.is_private !== "boolean") return json({ error: "is_private is required" }, 400);
      const { is_private: _hidden, ...rest } = body.workout;
      a.workouts[i] = { ...a.workouts[i], ...rest, exercises: titled(body.workout.exercises) };
      return json({ workout: [a.workouts[i]] });
    }
    return json(a.workouts[i]);
  }
  if (kind === "exercise_history") {
    const sets = a.workouts.flatMap((w) =>
      w.exercises.filter((e: any) => e.exercise_template_id === id).flatMap((e: any) => e.sets.map((s: any) => ({ workout_id: w.id, workout_title: w.title, workout_start_time: w.start_time, exercise_template_id: id, ...s, set_type: s.type }))),
    );
    return json({ exercise_history: sets });
  }
  if (kind === "routine_folders" && method === "GET") return page(a.folders, "routine_folders", q, 10);
  if (kind === "routine_folders" && method === "POST") {
    const f = { id: nextId++, title: body.routine_folder.title };
    a.folders.push(f);
    return json({ routine_folder: f }, 201);
  }
  if (kind === "routines" && !id && method === "GET") return page(a.routines, "routines", q, 10);
  if (kind === "routines" && method === "POST") {
    const r = { id: `r${nextId++}`, ...body.routine, exercises: titled(body.routine.exercises) };
    a.routines.push(r);
    return json({ routine: [r] }, 201);
  }
  if (kind === "routines" && id) {
    const i = a.routines.findIndex((r) => r.id === id);
    if (i < 0) return json({ error: "Routine not found" }, 404);
    if (method === "PUT") {
      if (body.routine.exercises.some((e: any) => e.sets.some((s: any) => "rep_range" in s && s.rep_range === null))) return json({ error: "rep_range must be an object" }, 400);
      a.routines[i] = { ...a.routines[i], ...body.routine, exercises: titled(body.routine.exercises) };
    }
    const { notes: _notShown, ...shown } = a.routines[i]; // Hevy's GET leaves a routine's notes out
    return json({ routine: shown });
  }
  if (kind === "body_measurements" && !id && method === "GET") return page(a.measurements, "body_measurements", q, 10);
  if (kind === "body_measurements" && method === "POST") {
    if (Object.values(body).some((v) => v === null)) return json({ error: "null not allowed" }, 400);
    a.measurements.push(body);
    return json({}, 201);
  }
  if (kind === "body_measurements" && id) {
    const i = a.measurements.findIndex((m) => m.date === id);
    if (i < 0) return json({ error: "Not found" }, 404);
    if (method === "PUT") a.measurements[i] = { date: id, ...body };
    return json(a.measurements[i]);
  }
  return json({ error: `fake Hevy has no ${method} ${path}` }, 404);
}) as typeof fetch;

const outbox: Outbox = {
  async sendText(chatId, text, quote) {
    sent.push({ chatId, text, quote });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

const chatOf = (who: { name: string; number: string }): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const groupOf = (who: { name: string; number: string }): ChatContext => ({ chatId: "1203@g.us", isGroup: true, chatName: "Gym Bros", sender: { ...who, isContact: true }, replyTo: { id: "their-message" } });
const say = (chat: ChatContext, text: string) => handleIncoming({ chat, text, addressed: true } satisfies Incoming, outbox);
const tool = (chat: ChatContext, name: string, input: unknown) => runTool(name, input, { chat, outbox });
const last = () => sent.at(-1)!.text;
const codeFromPreview = () => /YA (\d{4})/.exec(last())![1];
const writes = () => calls.filter((c) => c.method !== "GET");
const rows = (table: string, chatId?: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}${chatId ? " WHERE chat_id = ?" : ""}`).get(...(chatId ? [chatId] : [])) as { n: number }).n;

async function link(who: { name: string; number: string }, key: string) {
  await say(chatOf(who), `/hevy ${key}`);
}

beforeEach(() => {
  for (const table of ["hevy_accounts", "hevy_pending", "hevy_privacy", "sessions"]) db.prepare(`DELETE FROM ${table}`).run();
  forgetCatalog(WIFE.number);
  forgetCatalog(ADMIN.number);
  resetHevy();
  claude.reset();
  sent = [];
});

describe("linking Hevy", () => {
  it("explains what happens to the data, and where the key is, before anyone pastes one", async () => {
    await say(chatOf(WIFE), "/hevy");
    assert.match(last(), /hevy\.com\/settings\?developer/);
    assert.match(last(), /dikirim ke Claude \(Anthropic\)/);
    assert.match(last(), /server yang dikelola Albert/);
    assert.match(last(), /\/privacy/);
    assert.equal(claude.requests.length, 0);
  });

  it("checks the key with Hevy, keeps it encrypted and never shows it to Claude", async () => {
    await link(WIFE, KEYS.sarah);
    assert.match(last(), /Hevy terhubung: \*sarah_lifts\*/);
    assert.match(last(), /hapus pesan berisi API key/);
    const row = db.prepare("SELECT api_key FROM hevy_accounts WHERE number = ?").get(WIFE.number) as { api_key: string };
    assert.notEqual(row.api_key, KEYS.sarah);
    assert.equal(decrypt(row.api_key), KEYS.sarah);

    claude.replies.push({ content: [{ type: "text", text: "Oke!" }], stop_reason: "end_turn" });
    await say(chatOf(WIFE), "halo");
    assert.ok(!JSON.stringify(claude.requests).includes(KEYS.sarah), "the key never reaches Claude");
  });

  it("takes a key pasted on its own, without Claude", async () => {
    await say(chatOf(WIFE), ` ${KEYS.sarah} `);
    assert.match(last(), /Hevy terhubung/);
    assert.equal(claude.requests.length, 0);
  });

  it("says plainly when Hevy refuses the key, and keeps nothing", async () => {
    await link(WIFE, KEYS.revoked);
    assert.match(last(), /ditolak Hevy/);
    assert.equal(rows("hevy_accounts"), 0);
  });

  it("never links from a group, and warns that a key posted there is exposed", async () => {
    await say(groupOf(WIFE), `/hevy ${KEYS.sarah}`);
    assert.match(last(), /Jangan kirim API key di grup/);
    assert.equal(sent.at(-1)!.quote, undefined, "the warning doesn't quote the key back");
    assert.equal(calls.length, 0, "the key isn't even tried");
    assert.equal(rows("hevy_accounts"), 0);
  });

  it("forgets the key and the chat history on /hevy putus", async () => {
    await link(WIFE, KEYS.sarah);
    db.prepare("INSERT OR REPLACE INTO sessions (chat_id, system, messages, tokens, updated_at) VALUES (?, '', '[]', 0, ?)").run(chatOf(WIFE).chatId, Date.now());
    await say(chatOf(WIFE), "/hevy putus");
    assert.match(last(), /Hevy diputus/);
    assert.equal(rows("hevy_accounts"), 0);
    assert.equal(rows("sessions", chatOf(WIFE).chatId), 0);
  });
});

describe("whose Hevy is used", () => {
  it("offers the tools only in a linked person's private chat", async () => {
    await link(WIFE, KEYS.sarah);
    const names = hevyTools(chatOf(WIFE)).map((t) => (t as { name: string }).name);
    assert.ok(names.includes("hevy_log_workout") && names.includes("hevy_find_exercises"));
    assert.equal(hevyTools(groupOf(WIFE)).length, 0);
    assert.equal(hevyTools(chatOf(ADMIN)).length, 0);
    assert.match(buildSystemPrompt(chatOf(WIFE), [], ""), /sarah_lifts/);
    assert.match(buildSystemPrompt(chatOf(ADMIN), [], ""), /send \/hevy/);
    assert.doesNotMatch(buildSystemPrompt(groupOf(WIFE), [], ""), /sarah_lifts/);
  });

  it("always uses the sender's own key", async () => {
    await link(WIFE, KEYS.sarah);
    await link(ADMIN, KEYS.albert);
    calls = [];
    await tool(chatOf(WIFE), "hevy_workouts", { number: ADMIN.number });
    assert.ok(calls.length > 0 && calls.every((c) => c.key === KEYS.sarah));
    const inGroup = await tool(groupOf(WIFE), "hevy_workouts", {});
    assert.equal(inGroup.isError, true);
  });

  it("tells Claude what to do when the key stops working", async () => {
    await link(WIFE, KEYS.sarah);
    delete accounts[KEYS.sarah];
    const result = await tool(chatOf(WIFE), "hevy_workouts", {});
    assert.equal(result.isError, true);
    assert.match(result.content, /send \/hevy with a new key/);
  });
});

describe("finding exercises", () => {
  it("understands gym shorthand and plurals", () => {
    assert.equal(findExercises(BUILT_IN, "db bench press")[0].template.title, "Bench Press (Dumbbell)");
    assert.equal(findExercises(BUILT_IN, "lat pull down")[0].template.title, "Lat Pulldown (Cable)");
    assert.equal(findExercises(BUILT_IN, "bicep curls")[0].template.title, "Bicep Curl (Dumbbell)");
    assert.equal(findExercises(BUILT_IN, "pullups")[0].template.title, "Pull Up");
    assert.equal(matchScore("Bench Press (Barbell)", "bench press (barbell)"), 1);
    assert.equal(findExercises(BUILT_IN, "zumba").length, 0);
  });

  it("searches every page of their exercises, custom ones included", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].templates.push({ id: "MINE1", title: "Hip Thrust (Machine)", type: "weight_reps", primary_muscle_group: "glutes", is_custom: true });
    const result = await tool(chatOf(WIFE), "hevy_find_exercises", { names: ["hip thrust", "bench press"] });
    assert.match(result.content, /MINE1 \| Hip Thrust \(Machine\) \| weight_reps \| glutes \| their own/);
    assert.match(result.content, /D04AC939 \| Bench Press \(Barbell\)/);
    assert.equal(calls.filter((c) => c.path === "/exercise_templates").length, 2, "two pages of 100");

    accounts[KEYS.sarah].templates.push({ id: "MINE2", title: "Sissy Squat", type: "reps_only", primary_muscle_group: "quadriceps", is_custom: true });
    const fresh = await tool(chatOf(WIFE), "hevy_find_exercises", { names: ["sissy squat"] });
    assert.match(fresh.content, /MINE2 \| Sissy Squat/, "one made in the app a minute ago is found too");
  });
});

describe("logging a workout", () => {
  const workout = {
    title: "Push pagi",
    start: "2026-10-28T07:00",
    duration_minutes: 50,
    exercises: [
      { exercise_template_id: "D04AC939", sets: [{ type: "warmup", weight_kg: 40, reps: 10 }, { weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7, rpe: 9 }] },
      { new_exercise: { title: "Cable Fly Low to High", exercise_type: "weight_reps", equipment_category: "machine", muscle_group: "chest" }, sets: [{ weight_lb: 30, reps: 12 }, { weight_lb: 30, reps: 12 }] },
      { exercise_template_id: "C6272009", sets: [{ duration_seconds: 60 }] },
    ],
  };

  it("shows a preview and saves nothing until the code comes back", async () => {
    await link(WIFE, KEYS.sarah);
    calls = [];
    const result = await tool(chatOf(WIFE), "hevy_log_workout", workout);
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /Nothing is saved yet/);
    assert.ok(!/YA \d{4}/.test(result.content), "Claude never sees the code");
    assert.equal(writes().length, 0);
    const preview = last();
    assert.match(preview, /\*Push pagi\* · Rab, 28 Okt 2026, 07\.00–07\.50 \(50 mnt\)/);
    assert.match(preview, /🔒 Privat/);
    assert.match(preview, /\*Bench Press \(Barbell\)\*\n {3}40 kg × 10 \(pemanasan\), 2× 80 kg × 8, 80 kg × 7 @RPE 9/);
    assert.match(preview, /\*Cable Fly Low to High\* ✨ _baru: beban & repetisi · mesin · dada_\n {3}2× 13,61 kg × 12/);
    assert.match(preview, /\*Plank\*\n {3}1:00/);
    assert.match(preview, /3 latihan, 7 set/);
  });

  it("creates the new exercise once, then the workout, in UTC and kilograms", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", workout);
    calls = [];
    await say(chatOf(WIFE), `ya ${codeFromPreview()}`);
    assert.match(last(), /✅ Workout tersimpan di Hevy: \*Push pagi\* \(3 latihan, 7 set\)\. Latihan baru: Cable Fly Low to High\./);
    const [template, saved] = writes();
    assert.equal(template.path, "/exercise_templates");
    assert.equal(saved.path, "/workouts");
    const w = saved.body.workout;
    assert.equal(w.start_time, "2026-10-28T00:00:00Z");
    assert.equal(w.end_time, "2026-10-28T00:50:00Z");
    assert.equal(w.is_private, true);
    assert.equal(w.exercises[1].exercise_template_id, accounts[KEYS.sarah].templates.at(-1)!.id);
    assert.equal(w.exercises[1].sets[0].weight_kg, 13.608);
    assert.deepEqual(w.exercises[0].sets[3], { type: "normal", weight_kg: 80, reps: 7, distance_meters: null, duration_seconds: null, custom_metric: null, rpe: 9 });
    assert.equal(claude.requests.length, 0, "the confirmation never goes through Claude");
    assert.match(hevyNotes(chatOf(WIFE))!, /hevy_log_workout .*: done — Workout tersimpan.*workout id w\d+/);

    const used = /YA (\d{4})/.exec(sent.find((s) => s.text.includes("Balas *YA"))!.text)![1];
    assert.equal(await confirmHevy(chatOf(WIFE), `YA ${used}`, outbox), false, "a code works once");
    assert.equal(writes().length, 2);
  });

  it("refuses sets that don't fit the exercise, instead of dropping what they said", async () => {
    await link(WIFE, KEYS.sarah);
    const noWeight = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, exercises: [{ exercise_template_id: "D04AC939", sets: [{ reps: 8 }] }] });
    assert.match(noWeight.content, /every set needs weight_kg/);
    const repsOnPlank = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, exercises: [{ exercise_template_id: "C6272009", sets: [{ reps: 3 }] }] });
    assert.match(repsOnPlank.content, /can't have reps/);
    const unknown = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, exercises: [{ exercise_template_id: "NOPE", sets: [{ reps: 3 }] }] });
    assert.match(unknown.content, /no exercise "NOPE"/);
    const future = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, start: "2030-01-01T07:00" });
    assert.match(future.content, /future/);
    assert.equal(writes().length, 0);
    assert.ok(!sent.some((s) => s.text.includes("Balas *YA")), "no preview for a bad plan");
  });

  it("reuses an existing exercise rather than making a twin", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", {
      ...workout,
      exercises: [{ new_exercise: { title: "bench press (barbell)", exercise_type: "weight_reps", equipment_category: "barbell", muscle_group: "chest" }, sets: [{ weight_kg: 60, reps: 5 }] }],
    });
    assert.doesNotMatch(last(), /✨/);
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    assert.ok(!writes().some((c) => c.path === "/exercise_templates"));
    assert.equal(writes().at(-1)!.body.workout.exercises[0].exercise_template_id, "D04AC939");
  });

  it("warns when a workout at the same time is already in Hevy", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].workouts.push({ id: "old", title: "Chest day", start_time: "2026-10-28T00:10:00Z", end_time: "2026-10-28T01:00:00Z", exercises: [] });
    await tool(chatOf(WIFE), "hevy_log_workout", workout);
    assert.match(last(), /⚠️ Sudah ada workout di jam yang sama: \*Chest day\*/);
  });

  it("finds a workout already logged even when backfilling an old one", async () => {
    await link(WIFE, KEYS.sarah);
    for (let i = 0; i < 12; i++) {
      const start = Date.parse("2026-11-01T00:00:00Z") - i * 3_600_000 * 20;
      accounts[KEYS.sarah].workouts.push({ id: `recent${i}`, title: `Recent ${i}`, start_time: new Date(start).toISOString(), end_time: new Date(start + 3_600_000).toISOString(), exercises: [] });
    }
    accounts[KEYS.sarah].workouts.push({ id: "old", title: "Chest day", start_time: "2026-10-15T00:10:00Z", end_time: "2026-10-15T01:00:00Z", exercises: [] });
    await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, start: "2026-10-15T07:00" });
    assert.match(last(), /⚠️ Sudah ada workout di jam yang sama: \*Chest day\*/);
  });

  it("retires the old code when a corrected version is proposed", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", workout);
    const first = codeFromPreview();
    await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, title: "Push pagi (fixed)" });
    const second = codeFromPreview();
    await say(chatOf(WIFE), `YA ${first}`);
    assert.match(last(), /versi lama/);
    assert.equal(writes().length, 0);
    await say(chatOf(WIFE), `YA ${second}`);
    assert.equal(writes().filter((c) => c.path === "/workouts").length, 1);
    assert.equal(writes().find((c) => c.path === "/workouts")!.body.workout.title, "Push pagi (fixed)");
  });

  it("lets an expired code save nothing", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", workout);
    db.prepare("UPDATE hevy_pending SET created_at = ?").run(Date.now() - 11 * 60_000);
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    assert.match(last(), /kedaluwarsa/);
    assert.equal(writes().length, 0);
  });
});

describe("changing what's in Hevy", () => {
  async function logged() {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", {
      title: "Pull",
      start: "2026-10-29T18:00",
      end: "2026-10-29T19:00",
      exercises: [
        { exercise_template_id: "6A6C31A5", superset: 0, sets: [{ weight_kg: 50, reps: 10 }] },
        { exercise_template_id: "ABCD0001", superset: 0, sets: [{ weight_kg: 12, reps: 12 }] },
      ],
    });
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    return accounts[KEYS.sarah].workouts[0].id as string;
  }

  it("renames a workout and keeps its exercises, supersets and privacy", async () => {
    const id = await logged();
    await tool(chatOf(WIFE), "hevy_update_workout", { workout_id: id, title: "Pull (back & biceps)" });
    assert.match(last(), /Judul baru: \*Pull \(back & biceps\)\*/);
    assert.doesNotMatch(last(), /Hevy tidak memberi tahu/, "Friday remembers the privacy it set");
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    const put = writes().at(-1)!;
    assert.equal(put.method, "PUT");
    assert.equal(put.body.workout.is_private, true);
    assert.equal(put.body.workout.start_time, "2026-10-29T11:00:00Z");
    assert.deepEqual(put.body.workout.exercises.map((e: any) => [e.exercise_template_id, e.superset_id]), [["6A6C31A5", 0], ["ABCD0001", 0]]);
    assert.match(last(), /✅ Workout diubah/);
  });

  it("says when it can't know a workout's privacy, since Hevy won't tell", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].workouts.push({ id: "app1", title: "From the app", start_time: "2026-10-27T10:00:00Z", end_time: "2026-10-27T11:00:00Z", exercises: [] });
    await tool(chatOf(WIFE), "hevy_update_workout", { workout_id: "app1", description: "Felt strong" });
    assert.match(last(), /Hevy tidak memberi tahu setelan lamanya/);
  });

  it("builds a whole program in a new folder with one confirmation", async () => {
    await link(WIFE, KEYS.sarah);
    const day = (title: string) => ({ title, exercises: [{ exercise_template_id: "D04AC939", rest_seconds: 120, sets: [{ weight_kg: 60, rep_range: { start: 8, end: 10 } }, { weight_kg: 60, rep_range: { start: 8, end: 10 } }] }] });
    await tool(chatOf(WIFE), "hevy_create_routines", { new_folder: "PPL", routines: [day("Push A"), day("Push B")] });
    assert.match(last(), /Folder: \*PPL\* \(baru\)/);
    assert.match(last(), /2× 60 kg × 8–10 · istirahat 2:00/);
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    const posted = writes();
    assert.deepEqual(posted.map((c) => c.path), ["/routine_folders", "/routines", "/routines"]);
    const folderId = accounts[KEYS.sarah].folders[0].id;
    assert.ok(posted.slice(1).every((c) => c.body.routine.folder_id === folderId));
    assert.deepEqual(posted[1].body.routine.exercises[0].sets[0].rep_range, { start: 8, end: 10 });
    assert.match(last(), /Rutinitas dibuat di Hevy: \*Push A\*, \*Push B\* \(folder PPL\)/);
  });

  it("edits a routine without wiping its notes or sending empty rep ranges", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].routines.push({ id: "rA", title: "Push A", notes: "Slow eccentrics", folder_id: null, exercises: [{ title: "Bench Press (Barbell)", exercise_template_id: "D04AC939", supersets_id: null, rest_seconds: 90, sets: [{ type: "normal", reps: 8, weight_kg: 60 }] }] });
    await tool(chatOf(WIFE), "hevy_update_routine", { routine_id: "rA", title: "Push A (heavy)" });
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    let put = writes().at(-1)!;
    assert.ok(!("notes" in put.body.routine), "notes Hevy didn't show us are left alone");
    assert.equal(put.body.routine.exercises[0].rest_seconds, 90);

    await tool(chatOf(WIFE), "hevy_update_routine", { routine_id: "rA", exercises: [{ exercise_template_id: "D04AC939", sets: [{ weight_kg: 62.5, reps: 8 }] }] });
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    put = writes().at(-1)!;
    assert.match(last(), /✅ Rutinitas diubah/);
    assert.ok(!("rep_range" in put.body.routine.exercises[0].sets[0]));
  });

  it("records body weight, keeping what's already saved that day", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].measurements.push({ date: "2026-11-01", weight_kg: 73, waist: 81 });
    await tool(chatOf(WIFE), "hevy_log_measurements", { date: "2026-11-01", weight_lb: 160 });
    assert.match(last(), /Berat: 72,57 kg _\(sebelumnya 73 kg\)_/);
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    const put = writes().at(-1)!;
    assert.equal(put.method, "PUT");
    assert.deepEqual(put.body, { weight_kg: 72.57, waist: 81 });

    await tool(chatOf(WIFE), "hevy_log_measurements", { date: "2026-11-02", fat_percent: 18 });
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    assert.deepEqual(writes().at(-1)!.body, { date: "2026-11-02", fat_percent: 18 });
  });
});

describe("reading progress", () => {
  it("summarises a period and an exercise's bests from the real sets", async () => {
    await link(WIFE, KEYS.sarah);
    const w = (id: string, start: string, kg: number) => ({
      id,
      title: "Push",
      start_time: start,
      end_time: new Date(Date.parse(start) + 3_600_000).toISOString(),
      exercises: [{ title: "Bench Press (Barbell)", exercise_template_id: "D04AC939", sets: [{ type: "warmup", weight_kg: 40, reps: 10 }, { type: "normal", weight_kg: kg, reps: 5 }] }],
    });
    accounts[KEYS.sarah].workouts.push(w("a", "2026-10-20T00:00:00Z", 80), w("b", "2026-10-27T00:00:00Z", 85));
    const stats = await tool(chatOf(WIFE), "hevy_stats", { from: "2026-10-19", to: "2026-11-01" });
    assert.match(stats.content, /^2 workouts between 2026-10-19 and 2026-11-01/);
    assert.match(stats.content, /Working sets per primary muscle: chest 2/);
    assert.match(stats.content, /heaviest 85 kg × 5/);
    const history = await tool(chatOf(WIFE), "hevy_exercise_history", { exercise_template_id: "D04AC939" });
    assert.match(history.content, /Bench Press \(Barbell\): 2 sessions/);
    assert.match(history.content, /best estimated 1RM 99\.17 kg \(85 kg × 5\) on 2026-10-27/);
    assert.match(history.content, /Estimated 1RM went from 93\.33 to 99\.17 kg/);
  });

  it("keeps Hevy data out of the server logs", async () => {
    await link(WIFE, KEYS.sarah);
    accounts[KEYS.sarah].workouts.push({ id: "secret", title: "Rahasia Leg Day", start_time: "2026-10-20T00:00:00Z", end_time: "2026-10-20T01:00:00Z", exercises: [] });
    claude.replies.push({ content: [{ type: "tool_use", id: "t1", name: "hevy_workouts", input: {} }], stop_reason: "tool_use" });
    claude.replies.push({ content: [{ type: "text", text: "Kemarin leg day." }], stop_reason: "end_turn" });
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      await say(chatOf(WIFE), "kemarin aku latihan apa?");
    } finally {
      console.log = log;
    }
    assert.ok(logged.some((l) => l.includes("tool hevy_workouts")));
    assert.ok(!logged.some((l) => l.includes("Rahasia")));
  });
});
