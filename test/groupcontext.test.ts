import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming, type Media } from "../src/bot.js";
import { db } from "../src/db.js";
import { contextOn, MAX_AGE_MS, MAX_KEPT, rememberGroupMessage } from "../src/groupcontext.js";
import type { Outbox } from "../src/types.js";

const GROUP = "120363000000000077@g.us";
const OTHER = { name: "Budi", number: "6285555555555" };

let sent: { chatId: string; text: string }[] = [];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
  groups: async () => [],
};

const say = (from: { name: string; number: string }, text: string, addressed = true, media?: Media): Incoming => ({
  chat: { chatId: GROUP, isGroup: true, chatName: "Arisan", sender: { ...from, isContact: from !== OTHER } },
  text,
  media,
  addressed,
});
const answer = (t: string) => claude.replies.push({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
/** Every text block of the last message Friday sent Claude. */
const lastTurn = () => (claude.requests.at(-1)!.body.messages.at(-1).content as { type: string; text?: string }[]).map((b) => b.text ?? `[${b.type}]`).join("\n");
const logged = () => (db.prepare("SELECT COUNT(*) AS n FROM group_log").get() as { n: number }).n;
const photo: Media = { kind: "image", mimetype: "image/jpeg", size: 5, download: async () => Buffer.from("x") };

beforeEach(async () => {
  sent = [];
  claude.reset();
  if (contextOn(GROUP)) await handleIncoming(say(ADMIN, "/context off"), outbox);
  db.prepare("DELETE FROM group_log").run();
  sent = [];
});

describe("group context", () => {
  it("is off by default: messages that don't call Friday are neither kept nor sent", async () => {
    await handleIncoming(say(OTHER, "besok arisan di rumah Rina ya", false), outbox);
    assert.equal(logged(), 0);
    answer("Siap.");
    await handleIncoming(say(WIFE, "Friday, arisan di mana?"), outbox);
    assert.doesNotMatch(lastTurn(), /Rina/);
    assert.match(JSON.stringify(claude.requests.at(-1)!.body.system), /you only see messages that mention you/);
  });

  it("once the admin turns it on, tells the group and hands the messages in between to Claude once", async () => {
    await handleIncoming(say(ADMIN, "/context on"), outbox);
    assert.equal(sent[0].chatId, GROUP, "the group is told");
    assert.match(sent[0].text, /ikut membaca semua pesan di grup ini[\s\S]*24 jam/);
    assert.equal(sent[1].chatId, `${ADMIN.number}@s.whatsapp.net`);
    assert.ok(contextOn(GROUP));

    await handleIncoming(say(OTHER, "besok arisan di rumah Rina ya", false), outbox);
    await handleIncoming(say(WIFE, "jam 7 malam", false), outbox);
    await handleIncoming(say(OTHER, "", false, photo), outbox);
    assert.equal(claude.requests.length, 0, "Friday doesn't answer them");
    assert.equal(sent.length, 2);

    answer("Di rumah Rina, jam 7 malam.");
    await handleIncoming(say(WIFE, "Friday, arisan di mana dan jam berapa?"), outbox);
    const turn = lastTurn();
    assert.match(
      turn,
      new RegExp(`weren't addressed to you[\\s\\S]*\\] Budi: besok arisan di rumah Rina ya\\n\\[\\d\\d:\\d\\d\\] ${WIFE.name}: jam 7 malam\\n\\[\\d\\d:\\d\\d\\] Budi: \\[photo\\]\\][\\s\\S]*arisan di mana dan jam berapa`),
    );
    assert.match(JSON.stringify(claude.requests.at(-1)!.body.system), /the others in between come with them as context/);

    answer("Sama-sama.");
    await handleIncoming(say(WIFE, "Friday, makasih"), outbox);
    assert.doesNotMatch(lastTurn(), /Rina/, "each is handed over once");
  });

  it("keeps only the newest messages of the past day", () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(`context:${GROUP}`);
    const chat = say(OTHER, "").chat;
    const now = Date.now();
    rememberGroupMessage(chat, "kemarin", undefined, now - MAX_AGE_MS - 1000);
    for (let i = 0; i < MAX_KEPT + 10; i++) rememberGroupMessage(chat, `pesan ${i}`, undefined, now);
    const kept = db.prepare("SELECT text FROM group_log WHERE chat_id = ? ORDER BY id").all(GROUP) as { text: string }[];
    assert.equal(kept.length, MAX_KEPT);
    assert.equal(kept[0].text, "pesan 10");
    rememberGroupMessage(chat, "x".repeat(2000), undefined, now);
    assert.equal((db.prepare("SELECT text FROM group_log ORDER BY id DESC").get() as { text: string }).text.length, 501);
  });

  it("only the admin can turn it on, and off forgets what was kept", async () => {
    answer("Hmm?");
    await handleIncoming(say(WIFE, "/context on"), outbox);
    assert.equal(contextOn(GROUP), false);

    await handleIncoming(say(ADMIN, "/context on"), outbox);
    await handleIncoming(say(OTHER, "rahasia", false), outbox);
    sent = [];
    await handleIncoming(say(ADMIN, "/context off"), outbox);
    assert.match(sent[0].text, /kembali hanya membaca pesan yang memanggilnya/);
    assert.equal(sent[0].chatId, GROUP);
    assert.equal(logged(), 0);
    await handleIncoming(say(OTHER, "lagi", false), outbox);
    assert.equal(logged(), 0);

    sent = [];
    await handleIncoming({ ...say(ADMIN, "/context on"), chat: { ...say(ADMIN, "").chat, chatId: `${ADMIN.number}@s.whatsapp.net`, isGroup: false } }, outbox);
    assert.match(sent[0].text, /Kirim \/context on atau \/context off di grupnya/);
  });
});
