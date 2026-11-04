import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { decrypt } from "../src/google.js";
import { findExercises, forgetCatalog, matchScore } from "../src/hevy.js";
import { hevyTools } from "../src/hevyapps.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { BUILT_IN, hevyFake, KEYS, resetHevy } from "./hevy-fake.js";

let sent: { chatId: string; text: string; quote?: unknown }[];

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
const writes = () => hevyFake.calls.filter((c) => c.method !== "GET");
const rows = (table: string, chatId?: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}${chatId ? " WHERE chat_id = ?" : ""}`).get(...(chatId ? [chatId] : [])) as { n: number }).n;

async function link(who: { name: string; number: string }, key: string) {
  await say(chatOf(who), `/hevy ${key}`);
}

beforeEach(() => {
  for (const table of ["hevy_accounts", "hevy_privacy", "sessions"]) db.prepare(`DELETE FROM ${table}`).run();
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
    assert.equal(hevyFake.calls.length, 0, "the key isn't even tried");
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
    hevyFake.calls = [];
    await tool(chatOf(WIFE), "hevy_workouts", { number: ADMIN.number });
    assert.ok(hevyFake.calls.length > 0 && hevyFake.calls.every((c) => c.key === KEYS.sarah));
    const inGroup = await tool(groupOf(WIFE), "hevy_workouts", {});
    assert.equal(inGroup.isError, true);
  });

  it("tells Claude what to do when the key stops working", async () => {
    await link(WIFE, KEYS.sarah);
    delete hevyFake.accounts[KEYS.sarah];
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
    hevyFake.accounts[KEYS.sarah].templates.push({ id: "MINE1", title: "Hip Thrust (Machine)", type: "weight_reps", primary_muscle_group: "glutes", is_custom: true });
    const result = await tool(chatOf(WIFE), "hevy_find_exercises", { names: ["hip thrust", "bench press"] });
    assert.match(result.content, /MINE1 \| Hip Thrust \(Machine\) \| weight_reps \| glutes \| their own/);
    assert.match(result.content, /D04AC939 \| Bench Press \(Barbell\)/);
    assert.equal(hevyFake.calls.filter((c) => c.path === "/exercise_templates").length, 2, "two pages of 100");

    hevyFake.accounts[KEYS.sarah].templates.push({ id: "MINE2", title: "Sissy Squat", type: "reps_only", primary_muscle_group: "quadriceps", is_custom: true });
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

  it("saves at once, creating the new exercise first, in UTC and kilograms", async () => {
    await link(WIFE, KEYS.sarah);
    hevyFake.calls = [];
    const result = await tool(chatOf(WIFE), "hevy_log_workout", workout);
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /^Saved\. \(workout id w\d+\)/);
    const [template, saved] = writes();
    assert.equal(template.path, "/exercise_templates");
    assert.equal(saved.path, "/workouts");
    assert.equal(writes().length, 2);
    const w = saved.body.workout;
    assert.equal(w.start_time, "2026-10-28T00:00:00Z");
    assert.equal(w.end_time, "2026-10-28T00:50:00Z");
    assert.equal(w.is_private, true);
    assert.equal(w.exercises[1].exercise_template_id, hevyFake.accounts[KEYS.sarah].templates.at(-1)!.id);
    assert.equal(w.exercises[1].sets[0].weight_kg, 13.608);
    assert.deepEqual(w.exercises[0].sets[3], { type: "normal", weight_kg: 80, reps: 7, distance_meters: null, duration_seconds: null, custom_metric: null, rpe: 9 });
    assert.equal(claude.requests.length, 0);
  });

  it("sends the person exactly what was saved, built from the real input", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", workout);
    const summary = last();
    assert.match(summary, /^✅ Workout tersimpan di Hevy: \*Push pagi\* \(3 latihan, 7 set\)\. Latihan baru: Cable Fly Low to High\./);
    assert.match(summary, /Rab, 28 Okt 2026, 07\.00–07\.50 \(50 mnt\) · 🔒 Privat/);
    assert.match(summary, /\*Bench Press \(Barbell\)\*\n {3}40 kg × 10 \(pemanasan\), 2× 80 kg × 8, 80 kg × 7 @RPE 9/);
    assert.match(summary, /\*Cable Fly Low to High\* ✨ _baru: beban & repetisi · mesin · dada_\n {3}2× 13,61 kg × 12/);
    assert.match(summary, /\*Plank\*\n {3}1:00/);
    assert.ok(!/YA \d{4}/.test(summary), "no code to type");
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
    assert.ok(!sent.some((s) => s.text.startsWith("✅ Workout")));
  });

  it("reuses an existing exercise rather than making a twin", async () => {
    await link(WIFE, KEYS.sarah);
    await tool(chatOf(WIFE), "hevy_log_workout", {
      ...workout,
      exercises: [{ new_exercise: { title: "bench press (barbell)", exercise_type: "weight_reps", equipment_category: "barbell", muscle_group: "chest" }, sets: [{ weight_kg: 60, reps: 5 }] }],
    });
    assert.doesNotMatch(last(), /✨/);
    assert.ok(!writes().some((c) => c.path === "/exercise_templates"));
    assert.equal(writes().at(-1)!.body.workout.exercises[0].exercise_template_id, "D04AC939");
  });

  it("won't save a second copy of a workout already in Hevy unless they say it's another one", async () => {
    await link(WIFE, KEYS.sarah);
    hevyFake.accounts[KEYS.sarah].workouts.push({ id: "old", title: "Chest day", start_time: "2026-10-28T00:10:00Z", end_time: "2026-10-28T01:00:00Z", exercises: [] });
    const refused = await tool(chatOf(WIFE), "hevy_log_workout", workout);
    assert.equal(refused.isError, true);
    assert.match(refused.content, /already has "Chest day" at that time/);
    assert.equal(writes().length, 0);
    const again = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, even_if_overlapping: true });
    assert.equal(again.isError, false, again.content);
    assert.equal(writes().filter((c) => c.path === "/workouts").length, 1);
  });

  it("finds that workout even when backfilling an old one", async () => {
    await link(WIFE, KEYS.sarah);
    for (let i = 0; i < 12; i++) {
      const start = Date.parse("2026-11-01T00:00:00Z") - i * 3_600_000 * 20;
      hevyFake.accounts[KEYS.sarah].workouts.push({ id: `recent${i}`, title: `Recent ${i}`, start_time: new Date(start).toISOString(), end_time: new Date(start + 3_600_000).toISOString(), exercises: [] });
    }
    hevyFake.accounts[KEYS.sarah].workouts.push({ id: "old", title: "Chest day", start_time: "2026-10-15T00:10:00Z", end_time: "2026-10-15T01:00:00Z", exercises: [] });
    const refused = await tool(chatOf(WIFE), "hevy_log_workout", { ...workout, start: "2026-10-15T07:00" });
    assert.match(refused.content, /already has "Chest day"/);
  });

  it("saves one copy when the same workout is asked for twice at once", async () => {
    await link(WIFE, KEYS.sarah);
    const [a, b] = await Promise.all([tool(chatOf(WIFE), "hevy_log_workout", workout), tool(chatOf(WIFE), "hevy_log_workout", workout)]);
    assert.deepEqual([a.isError, b.isError].sort(), [false, true]);
    assert.equal(writes().filter((c) => c.path === "/workouts").length, 1);
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
    return hevyFake.accounts[KEYS.sarah].workouts[0].id as string;
  }

  it("renames a workout and keeps its exercises, supersets and privacy", async () => {
    const id = await logged();
    const result = await tool(chatOf(WIFE), "hevy_update_workout", { workout_id: id, title: "Pull (back & biceps)" });
    assert.equal(result.isError, false, result.content);
    const put = writes().at(-1)!;
    assert.equal(put.method, "PUT");
    assert.equal(put.body.workout.is_private, true, "Friday remembers the privacy it set");
    assert.equal(put.body.workout.start_time, "2026-10-29T11:00:00Z");
    assert.deepEqual(put.body.workout.exercises.map((e: any) => [e.exercise_template_id, e.superset_id]), [["6A6C31A5", 0], ["ABCD0001", 0]]);
    assert.match(last(), /✅ Workout diubah di Hevy: \*Pull \(back & biceps\)\*\.\n\nSebelumnya: \*Pull\*/);
  });

  it("asks about privacy it can't know before editing a workout from the app", async () => {
    await link(WIFE, KEYS.sarah);
    hevyFake.accounts[KEYS.sarah].workouts.push({ id: "app1", title: "From the app", start_time: "2026-10-27T10:00:00Z", end_time: "2026-10-27T11:00:00Z", exercises: [] });
    const refused = await tool(chatOf(WIFE), "hevy_update_workout", { workout_id: "app1", description: "Felt strong" });
    assert.equal(refused.isError, true);
    assert.match(refused.content, /Ask them which it should be/);
    assert.equal(writes().length, 0);
    await tool(chatOf(WIFE), "hevy_update_workout", { workout_id: "app1", description: "Felt strong", is_private: false });
    assert.equal(writes().at(-1)!.body.workout.is_private, false);
  });

  it("builds a whole program in a new folder in one go", async () => {
    await link(WIFE, KEYS.sarah);
    const day = (title: string) => ({ title, exercises: [{ exercise_template_id: "D04AC939", rest_seconds: 120, sets: [{ weight_kg: 60, rep_range: { start: 8, end: 10 } }, { weight_kg: 60, rep_range: { start: 8, end: 10 } }] }] });
    await tool(chatOf(WIFE), "hevy_create_routines", { new_folder: "PPL", routines: [day("Push A"), day("Push B")] });
    const posted = writes();
    assert.deepEqual(posted.map((c) => c.path), ["/routine_folders", "/routines", "/routines"]);
    const folderId = hevyFake.accounts[KEYS.sarah].folders[0].id;
    assert.ok(posted.slice(1).every((c) => c.body.routine.folder_id === folderId));
    assert.deepEqual(posted[1].body.routine.exercises[0].sets[0].rep_range, { start: 8, end: 10 });
    assert.match(last(), /✅ Rutinitas dibuat di Hevy: \*Push A\*, \*Push B\* \(folder PPL\)/);
    assert.match(last(), /Folder: \*PPL\* \(baru\)/);
    assert.match(last(), /2× 60 kg × 8–10 · istirahat 2:00/);
  });

  it("edits a routine without wiping its notes or sending empty rep ranges", async () => {
    await link(WIFE, KEYS.sarah);
    hevyFake.accounts[KEYS.sarah].routines.push({ id: "rA", title: "Push A", notes: "Slow eccentrics", folder_id: null, exercises: [{ title: "Bench Press (Barbell)", exercise_template_id: "D04AC939", supersets_id: null, rest_seconds: 90, sets: [{ type: "normal", reps: 8, weight_kg: 60 }] }] });
    await tool(chatOf(WIFE), "hevy_update_routine", { routine_id: "rA", title: "Push A (heavy)" });
    let put = writes().at(-1)!;
    assert.ok(!("notes" in put.body.routine), "notes Hevy didn't show us are left alone");
    assert.equal(put.body.routine.exercises[0].rest_seconds, 90);

    await tool(chatOf(WIFE), "hevy_update_routine", { routine_id: "rA", exercises: [{ exercise_template_id: "D04AC939", sets: [{ weight_kg: 62.5, reps: 8 }] }] });
    put = writes().at(-1)!;
    assert.match(last(), /✅ Rutinitas diubah/);
    assert.ok(!("rep_range" in put.body.routine.exercises[0].sets[0]));
  });

  it("records body weight, keeping what's already saved that day", async () => {
    await link(WIFE, KEYS.sarah);
    hevyFake.accounts[KEYS.sarah].measurements.push({ date: "2026-11-01", weight_kg: 73, waist: 81 });
    await tool(chatOf(WIFE), "hevy_log_measurements", { date: "2026-11-01", weight_lb: 160 });
    assert.match(last(), /Berat: 72,57 kg _\(sebelumnya 73 kg\)_/);
    const put = writes().at(-1)!;
    assert.equal(put.method, "PUT");
    assert.deepEqual(put.body, { weight_kg: 72.57, waist: 81 });

    await tool(chatOf(WIFE), "hevy_log_measurements", { date: "2026-11-02", fat_percent: 18 });
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
    hevyFake.accounts[KEYS.sarah].workouts.push(w("a", "2026-10-20T00:00:00Z", 80), w("b", "2026-10-27T00:00:00Z", 85));
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
    hevyFake.accounts[KEYS.sarah].workouts.push({ id: "secret", title: "Rahasia Leg Day", start_time: "2026-10-20T00:00:00Z", end_time: "2026-10-20T01:00:00Z", exercises: [] });
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
