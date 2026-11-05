import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { runScheduledTask } from "../src/bot.js";
import { db } from "../src/db.js";
import { createReminder, fireDueReminders, listReminders, type Reminder } from "../src/reminders.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";

const GROUP = { id: "120363000000000001@g.us", name: "Futsal Kamis" };

let sent: { chatId: string; text: string }[] = [];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
  groups: async () => [GROUP, { id: "120363000000000002@g.us", name: "Keluarga" }],
};

const dm = (who: { name: string; number: string }, isContact = true): ChatContext => ({
  chatId: `${who.number}@s.whatsapp.net`,
  isGroup: false,
  chatName: who.name,
  sender: { ...who, isContact },
});

beforeEach(() => {
  sent = [];
  claude.reset();
  db.prepare("DELETE FROM reminders").run();
});

describe("scheduled messages and tasks", () => {
  it("sends a scheduled message exactly as written, and a reminder with its label", async () => {
    const message = createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "Selamat pagi semua ☀️", cron: "0 7 * * *", kind: "message" });
    createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "minum vitamin", cron: "0 7 * * *" });
    await fireDueReminders(outbox, new Date(message.due_at + 1000));
    assert.deepEqual(sent.map((s) => s.text).sort(), ["Selamat pagi semua ☀️", "⏰ *Reminder:* minum vitamin"]);
    assert.ok(listReminders(["chat-a"], "x").every((r) => r.due_at > message.due_at));
  });

  it("hands a due task to Friday once and moves it to its next run", async () => {
    const task = createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "kirim poll futsal", cron: "0 17 * * 5", kind: "task" });
    const ran: Reminder[] = [];
    const runTask = async (t: Reminder) => void ran.push(t);
    await fireDueReminders(outbox, new Date(task.due_at + 1000), undefined, runTask);
    await fireDueReminders(outbox, new Date(task.due_at + 20_000), undefined, runTask);
    assert.deepEqual(ran.map((t) => t.text), ["kirim poll futsal"]);
    assert.equal(sent.length, 0, "a task sends nothing by itself");
    assert.equal(listReminders(["chat-a"], "x")[0].due_at - task.due_at, 7 * 24 * 3600_000);
  });

  it("skips a message or task that is over an hour late, but still sends a late reminder", async () => {
    const message = createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "Selamat pagi", cron: "0 7 * * *", kind: "message" });
    createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "poll", cron: "0 7 * * *", kind: "task" });
    createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "obat", cron: "0 7 * * *" });
    const ran: Reminder[] = [];
    await fireDueReminders(outbox, new Date(message.due_at + 3 * 3600_000), undefined, async (t) => void ran.push(t));
    assert.equal(ran.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /obat[\s\S]*was due/);
    assert.ok(listReminders(["chat-a"], "x").every((r) => r.due_at > message.due_at + 3 * 3600_000));
  });

  it("keeps tasks from repeating more than hourly or piling up", () => {
    assert.throws(() => createReminder({ chatId: "c", createdBy: WIFE.number, text: "t", cron: "*/30 * * * *", kind: "task" }), /once an hour/);
    assert.throws(() => createReminder({ chatId: "c", createdBy: WIFE.number, text: "t", cron: "0,30 8 * * *", kind: "task" }), /once an hour/);
    for (let i = 0; i < 10; i++) createReminder({ chatId: "c", createdBy: WIFE.number, text: `t${i}`, cron: `${i} * * * *`, kind: "task" });
    assert.throws(() => createReminder({ chatId: "c", createdBy: WIFE.number, text: "t", cron: "0 9 * * *", kind: "task" }), /10 scheduled tasks/);
    createReminder({ chatId: "c", createdBy: WIFE.number, text: "fixed", cron: "*/5 * * * *", kind: "message" });
  });

  it("lets the admin schedule in a group from a private chat, and nobody else", async () => {
    const ok = await runTool("schedule_task", { instruction: "Kirim poll siapa ikut futsal", repeat_cron: "0 17 * * 4", in_group: "futsal" }, { chat: dm(ADMIN), outbox });
    assert.equal(ok.isError, false, ok.content);
    assert.match(ok.content, /in Futsal Kamis/);
    const row = db.prepare("SELECT chat_id, kind, chat_name FROM reminders WHERE text LIKE 'Kirim poll%'").get();
    assert.deepEqual(row, { chat_id: GROUP.id, kind: "task", chat_name: GROUP.name });

    const message = await runTool("create_reminder", { text: "Selamat pagi!", repeat_cron: "0 7 * * *", as_message: true, in_group: "keluarga" }, { chat: dm(ADMIN), outbox });
    assert.equal(message.isError, false, message.content);
    assert.match(message.content, /scheduled message[\s\S]*Keluarga/);

    const wife = await runTool("schedule_task", { instruction: "x", repeat_cron: "0 17 * * 4", in_group: "futsal" }, { chat: dm(WIFE), outbox });
    assert.equal(wife.isError, true);
    const stranger = await runTool("schedule_task", { instruction: "berita", repeat_cron: "0 7 * * *" }, { chat: dm({ name: "X", number: "6289999999999" }, false), outbox });
    assert.equal(stranger.isError, true);
  });

  it("runs a due task as a message from its owner in that chat, never as a command", async () => {
    const task = createReminder({ chatId: GROUP.id, createdBy: ADMIN.number, text: "/umumkan halo", when: "2099-01-01T17:00", kind: "task", chatName: GROUP.name });
    claude.replies.push({ content: [{ type: "text", text: "Ini rangkuman minggu ini." }], stop_reason: "end_turn" });
    await runScheduledTask(task, outbox);
    assert.equal(claude.requests.length, 1);
    const userText = claude.requests[0].body.messages.at(-1).content.findLast((b: any) => b.type === "text").text as string;
    assert.match(userText, new RegExp(`${ADMIN.name}: \\[Scheduled task #${task.id} that ${ADMIN.name} set up, due now: /umumkan halo\\]`));
    assert.deepEqual(sent, [{ chatId: GROUP.id, text: "Ini rangkuman minggu ini." }]);
  });

  it("lets a task stay quiet, and tells the next run what the last one said", async () => {
    const task = createReminder({ chatId: GROUP.id, createdBy: ADMIN.number, text: "cek poll, umumkan kalau ada vote", cron: "0 * * * *", kind: "task", chatName: GROUP.name });
    const due = () => db.prepare("SELECT * FROM reminders WHERE id = ?").get(task.id) as Reminder;
    const userText = () => claude.requests.at(-1)!.body.messages.at(-1).content.findLast((b: any) => b.type === "text").text as string;

    claude.replies.push({ content: [{ type: "text", text: "[skip]" }], stop_reason: "end_turn" });
    await runScheduledTask(due(), outbox);
    assert.deepEqual(sent, [], "nothing to say, nothing sent");
    assert.match(JSON.stringify(claude.requests[0].body.system), /reply exactly \[skip\]/);

    claude.replies.push({ content: [{ type: "text", text: "Budi ikut 🎉" }], stop_reason: "end_turn" });
    await runScheduledTask(due(), outbox);
    assert.match(userText(), /The last time it ran you sent nothing\./);
    assert.deepEqual(sent, [{ chatId: GROUP.id, text: "Budi ikut 🎉" }]);

    claude.replies.push({ content: [{ type: "text", text: " [skip]\n" }], stop_reason: "end_turn" });
    await runScheduledTask(due(), outbox);
    assert.match(userText(), /Your message the last time it ran: "Budi ikut 🎉"/);
    assert.equal(sent.length, 1);
    assert.equal(due().last_said, "");
  });

  it("stops a task whose owner is no longer a contact", async () => {
    const task = createReminder({ chatId: "chat-a", createdBy: "6280000000000", text: "berita pagi", cron: "0 7 * * *", kind: "task" });
    await runScheduledTask(task, outbox);
    assert.equal(claude.requests.length, 0);
    assert.equal(listReminders(["chat-a"], "x").length, 0);
  });
});
