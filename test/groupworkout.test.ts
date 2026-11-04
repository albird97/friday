import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { addContact } from "../src/contacts.js";
import { db } from "../src/db.js";
import { groupWorkoutTools } from "../src/groupworkout.js";
import { forgetCatalog } from "../src/hevy.js";
import { confirmHevy } from "../src/hevyapps.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { hevyFake, KEYS, resetHevy } from "./hevy-fake.js";

const BUDI = { name: "Budi", number: "6283333333333" };
const RINA = { name: "Rina", number: "6284444444444" }; // a contact, but never invited
const BUDI_KEY = "bbbbbbbb-1111-4222-8333-444444444444";
addContact(BUDI.name, BUDI.number);
addContact(RINA.name, RINA.number);

let sent: { chatId: string; text: string }[];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

type Who = { name: string; number: string };
const dm = (who: Who): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const gym = (who: Who): ChatContext => ({ chatId: "gymbros@g.us", isGroup: true, chatName: "Gym Bros", sender: { ...who, isContact: true } });
const say = (chat: ChatContext, text: string) => handleIncoming({ chat, text, addressed: true } satisfies Incoming, outbox);
const tool = (chat: ChatContext, name: string, input: unknown) => runTool(name, input, { chat, outbox });
const to = (who: Who | "group") => sent.filter((s) => s.chatId === (who === "group" ? "gymbros@g.us" : `${who.number}@s.whatsapp.net`));
const lastTo = (who: Who | "group") => to(who).at(-1)?.text ?? "";
const codeIn = (text: string) => /YA (\d{4})/.exec(text)![1];
const posted = (key: string) => hevyFake.calls.filter((c) => c.method === "POST" && c.path === "/workouts" && c.key === key);
const toolNames = (chat: ChatContext) => groupWorkoutTools(chat).map((t) => (t as { name: string }).name);

beforeEach(async () => {
  for (const table of ["hevy_accounts", "hevy_pending", "group_workouts", "group_workout_members", "sessions"]) db.prepare(`DELETE FROM ${table}`).run();
  for (const who of [ADMIN, WIFE, BUDI]) forgetCatalog(who.number);
  resetHevy({ budi: BUDI_KEY });
  claude.reset();
  sent = [];
  await say(dm(ADMIN), `/hevy ${KEYS.albert}`);
  await say(dm(WIFE), `/hevy ${KEYS.sarah}`);
});

const bench = (kg: number) => ({ name: "Bench Press (Barbell)", sets: [{ weight_kg: kg, reps: 8 }, { weight_kg: kg, reps: 8 }] });

/** Albert starts "Leg day" in the Gym Bros group and invites Sarah and Budi; Budi links Hevy. Returns the invite codes. */
async function invite() {
  await say(dm(BUDI), `/hevy ${BUDI_KEY}`);
  const result = await tool(gym(ADMIN), "group_workout_start", { title: "Leg day", invite: ["Sarah", "budi"] });
  assert.equal(result.isError, false, result.content);
  return { sarah: codeIn(lastTo(WIFE)), budi: codeIn(lastTo(BUDI)) };
}
async function everyoneIn() {
  const codes = await invite();
  await say(dm(WIFE), `YA ${codes.sarah}`);
  await say(dm(BUDI), `ya ${codes.budi}`);
}

describe("inviting people to a group workout", () => {
  it("asks each person privately, saying who can log for them and who will see it", async () => {
    await invite();
    const invitation = lastTo(WIFE);
    assert.match(invitation, /Albert mengajakmu workout bareng di grup \*Gym Bros\*: \*Leg day\*/);
    assert.match(invitation, /Sesama anggota \(Albert, Budi\) bisa mencatat set untukmu/);
    assert.match(invitation, /terlihat oleh semua anggota grup \*Gym Bros\*/);
    assert.match(invitation, /Baru masuk ke Hevy-mu kalau kamu konfirmasi dengan kode/);
    assert.equal(to("group").length, 0, "codes never go to the group");
    assert.equal(claude.requests.length, 0);
  });

  it("starts only once everyone has joined, and tells the group", async () => {
    const codes = await invite();
    const early = await tool(gym(ADMIN), "group_workout_log", { member: "Sarah", exercises: [bench(40)] });
    assert.match(early.content, /Not everyone has joined yet \(waiting for Sarah, Budi\)/);

    await say(dm(WIFE), `YA ${codes.sarah}`);
    assert.match(lastTo(WIFE), /✅ Kamu ikut \*Leg day\*\. Menunggu: Budi\./);
    assert.match(lastTo("group"), /👋 Sarah ikut \*Leg day\*\. Menunggu: Budi\./);
    await say(dm(BUDI), `YA ${codes.budi}`);
    assert.match(lastTo("group"), /💪 Semua sudah ikut: Albert, Sarah, Budi\. \*Leg day\* dimulai!/);
    assert.equal(claude.requests.length, 0, "joining never goes through Claude");
  });

  it("needs Hevy before joining", async () => {
    const result = await tool(dm(ADMIN), "group_workout_start", { title: "Pagi", invite: ["Budi"] });
    assert.equal(result.isError, false);
    const code = codeIn(lastTo(BUDI));
    assert.match(lastTo(BUDI), /kirim \/hevy untuk menghubungkannya/);
    await say(dm(BUDI), `YA ${code}`);
    assert.match(lastTo(BUDI), /Hubungkan Hevy dulu/);
    await say(dm(BUDI), `/hevy ${BUDI_KEY}`);
    await say(dm(BUDI), `YA ${code}`);
    assert.match(lastTo(BUDI), /💪 Semua sudah ikut: Albert, Budi\. \*Pagi\* dimulai!/);
    assert.equal(to(BUDI).filter((s) => s.text.includes("Kamu ikut")).length, 0, "one message when joining starts it");
  });

  it("lets the host drop someone who isn't coming, which starts it for the rest", async () => {
    const codes = await invite();
    await say(dm(WIFE), `YA ${codes.sarah}`);
    const out = await tool(gym(ADMIN), "group_workout_members", { remove: ["Budi"] });
    assert.match(out.content, /Budi is out\. Everyone left has joined, so it has started\./);
    await say(dm(BUDI), `YA ${codes.budi}`);
    assert.match(lastTo(BUDI), /tidak lagi diajak/, "a dropped invite no longer works");
    assert.equal(claude.requests.length, 0);
    const notHost = await tool(gym(WIFE), "group_workout_members", { invite: ["Rina"] });
    assert.match(notHost.content, /Only the host, Albert, can invite/);
  });

  it("keeps a name that isn't a contact from telling anyone but the admin", async () => {
    const asWife = await tool(dm(WIFE), "group_workout_start", { title: "X", invite: ["Mallory"] });
    assert.match(asWife.content, /Can't invite "Mallory"/);
    const asAdmin = await tool(dm(ADMIN), "group_workout_start", { title: "X", invite: ["Mallory"] });
    assert.match(asAdmin.content, /isn't a known contact/);
  });
});

describe("logging for each other", () => {
  it("logs for any member against that member's own Hevy exercises", async () => {
    await everyoneIn();
    hevyFake.calls = [];
    const r = await tool(gym(ADMIN), "group_workout_log", { member: "Sarah", exercises: [{ name: "Squat (Barbell)", new_exercise: { title: "Squat (Barbell)", exercise_type: "weight_reps", equipment_category: "barbell", muscle_group: "quadriceps" }, sets: [{ weight_kg: 40, reps: 10 }] }, bench(30)] });
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /Logged for Sarah: .*Bench Press \(Barbell\) 2× 30 kg × 8/);
    assert.ok(hevyFake.calls.every((c) => c.key === KEYS.sarah && c.method === "GET"), "only reads, with Sarah's key");
    await tool(gym(WIFE), "group_workout_log", { exercises: [{ name: "Bench Press (Barbell)", sets: [{ weight_kg: 32.5, reps: 6 }] }] });
    const status = await tool(gym(BUDI), "group_workout_status", {});
    assert.match(status.content, /- Sarah:\n {2}Squat \(Barbell\): 40 kg × 10 \(by Albert\)\n {2}Bench Press \(Barbell\): 2× 30 kg × 8, 32\.5 kg × 6 \(by Albert, Sarah\)/);
    assert.match(status.content, /- Budi: nothing logged yet/);
  });

  it("asks which exercise when a name could be several, instead of guessing", async () => {
    await everyoneIn();
    const r = await tool(gym(ADMIN), "group_workout_log", { member: "Budi", exercises: [{ name: "bench press", sets: [{ weight_kg: 60, reps: 5 }] }] });
    assert.equal(r.isError, true);
    assert.match(r.content, /Not sure which exercise "bench press" is in Budi's Hevy\. Candidates: .*Bench Press \(Barbell\).*Bench Press \(Dumbbell\)/);
  });

  it("tells the member privately when someone logs for them outside the group", async () => {
    await everyoneIn();
    await tool(dm(BUDI), "group_workout_log", { member: "Sarah", exercises: [bench(35)] });
    assert.match(lastTo(WIFE), /📝 Budi mencatat untukmu di \*Leg day\*:\nBench Press \(Barbell\): 2× 35 kg × 8/);
  });

  it("is only for members, and only in their private chats or the session's group", async () => {
    await everyoneIn();
    assert.ok(toolNames(gym(ADMIN)).includes("group_workout_log"));
    assert.ok(toolNames(dm(WIFE)).includes("group_workout_log"));
    const otherGroup: ChatContext = { ...gym(ADMIN), chatId: "family@g.us", chatName: "Family" };
    assert.ok(!toolNames(otherGroup).includes("group_workout_log"));
    assert.deepEqual(toolNames(gym(RINA)), [], "Rina has no Hevy and wasn't invited");
    const outsider = await tool(gym(RINA), "group_workout_log", { member: "Sarah", exercises: [bench(99)] });
    assert.equal(outsider.isError, true);
    assert.match(buildSystemPrompt(gym(RINA), [], ""), /group workouts/);
  });
});

describe("finishing a group workout", () => {
  it("sends each member their own workout and saves nothing until they confirm it", async () => {
    await everyoneIn();
    await tool(gym(ADMIN), "group_workout_log", { exercises: [bench(80)] });
    await tool(gym(ADMIN), "group_workout_log", { member: "Sarah", exercises: [bench(40)] });
    hevyFake.calls = [];
    const r = await tool(gym(WIFE), "group_workout_finish", {});
    assert.match(r.content, /Albert: preview sent; Sarah: preview sent; Budi: nothing logged/);
    assert.match(lastTo("group"), /🏁 \*Leg day\* selesai!/);
    assert.equal(hevyFake.calls.filter((c) => c.method !== "GET").length, 0, "nothing saved yet");

    const sarahPreview = lastTo(WIFE);
    assert.match(sarahPreview, /Ini catatanmu dari workout bareng Albert, Budi/);
    assert.match(sarahPreview, /\*Bench Press \(Barbell\)\*\n {3}2× 40 kg × 8/);
    assert.doesNotMatch(sarahPreview, /80 kg/, "only her own sets");
    assert.match(lastTo(BUDI), /Tidak ada set yang tercatat untukmu/);

    // Albert can't save Sarah's workout with her code.
    assert.equal(await confirmHevy(dm(ADMIN), `YA ${codeIn(sarahPreview)}`, outbox), false);
    await say(dm(WIFE), `YA ${codeIn(sarahPreview)}`);
    assert.equal(posted(KEYS.sarah).length, 1);
    assert.equal(posted(KEYS.albert).length, 0, "Albert's waits for Albert");
    const w = posted(KEYS.sarah)[0].body.workout;
    assert.equal(w.title, "Leg day");
    assert.equal(w.description, "Workout bareng Albert, Budi");
    assert.ok(Date.parse(w.end_time) > Date.parse(w.start_time));
    assert.equal(w.exercises[0].sets.length, 2);
  });

  it("re-sends a member's own workout when their code ran out", async () => {
    await everyoneIn();
    await tool(gym(ADMIN), "group_workout_log", { member: "Sarah", exercises: [bench(40)] });
    await tool(gym(ADMIN), "group_workout_finish", {});
    const first = codeIn(lastTo(WIFE));
    assert.ok(toolNames(dm(WIFE)).includes("group_workout_finish"));
    const again = await tool(dm(WIFE), "group_workout_finish", {});
    assert.match(again.content, /Re-sent: Sarah: preview sent/);
    assert.notEqual(codeIn(lastTo(WIFE)), first);
    await say(dm(WIFE), `YA ${first}`);
    assert.match(lastTo(WIFE), /versi lama/, "the old code is retired");
  });

  it("lets only the host cancel, and then nobody can log", async () => {
    await everyoneIn();
    const notHost = await tool(gym(WIFE), "group_workout_cancel", {});
    assert.match(notHost.content, /Only the host, Albert, can cancel/);
    await tool(gym(ADMIN), "group_workout_cancel", {});
    assert.match(lastTo("group"), /❌ Albert membatalkan \*Leg day\*/);
    assert.ok(!toolNames(gym(WIFE)).includes("group_workout_log"));
  });
});
