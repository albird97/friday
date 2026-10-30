import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { parseDuration } from "../src/pause.js";
import { duration } from "../src/status.js";
import type { Outbox } from "../src/types.js";

type Sent = { chatId: string; text?: string; file?: string; data?: Buffer };
let sent = [] as Sent[];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile(chatId, file) {
    sent.push({ chatId, file: file.fileName, data: file.data });
  },
  async sendImage(chatId) {
    sent.push({ chatId });
  },
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

const GROUP = "120363000000000001@g.us";
const private_ = (n: string) => `${n}@s.whatsapp.net`;
const dm = (from: { name: string; number: string }, text: string): Incoming => ({
  chat: { chatId: private_(from.number), isGroup: false, chatName: from.name, sender: { ...from, isContact: true } },
  text,
  addressed: true,
});
const inGroup = (from: { name: string; number: string }, text: string): Incoming => ({
  chat: { chatId: GROUP, isGroup: true, chatName: "Kongkow", sender: { ...from, isContact: true } },
  text,
  addressed: true,
});
const answer = (t: string) => claude.replies.push({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

beforeEach(() => {
  claude.reset();
  sent = [];
});

describe("secret admin commands", () => {
  it("/stop silences Friday everywhere until /lanjut, but the admin's commands still work", async () => {
    await handleIncoming(dm(ADMIN, "/stop"), outbox);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text!, /berhenti membalas di semua chat/);

    sent = [] as Sent[];
    await handleIncoming(dm(WIFE, "halo"), outbox);
    await handleIncoming(inGroup(WIFE, "halo Friday"), outbox);
    assert.equal(sent.length, 0);
    assert.equal(claude.requests.length, 0, "nothing reaches Claude");

    await handleIncoming(dm(ADMIN, "halo"), outbox);
    assert.match(sent[0].text!, /sedang dihentikan.*\/lanjut/);

    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, "/status"), outbox);
    assert.match(sent[0].text!, /Semua chat: sampai dinyalakan lagi/);

    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, "/lanjut"), outbox);
    assert.match(sent[0].text!, /aktif lagi/);
    answer("Halo Sarah!");
    await handleIncoming(dm(WIFE, "halo"), outbox);
    assert.equal(sent.at(-1)!.text, "Halo Sarah!");
  });

  it("/diam quiets one group, answers the admin privately, and /bangun ends it", async () => {
    await handleIncoming(inGroup(ADMIN, "/diam 2j"), outbox);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, private_(ADMIN.number), "nothing is posted in the group");
    assert.match(sent[0].text!, /diam di \*Kongkow\*/);

    sent = [] as Sent[];
    await handleIncoming(inGroup(WIFE, "Friday, cuaca hari ini?"), outbox);
    assert.equal(sent.length, 0);
    answer("Cerah!");
    await handleIncoming(dm(WIFE, "cuaca hari ini?"), outbox);
    assert.equal(sent.at(-1)!.text, "Cerah!", "other chats still work");

    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, "/status"), outbox);
    assert.match(sent[0].text!, /Kongkow: sampai /);

    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/bangun"), outbox);
    assert.match(sent[0].text!, /aktif lagi di \*Kongkow\*/);
    answer("Cerah!");
    await handleIncoming(inGroup(WIFE, "Friday, cuaca hari ini?"), outbox);
    assert.equal(sent.at(-1)!.chatId, GROUP);
  });

  it("/diam only makes sense in a group and rejects an unreadable duration", async () => {
    await handleIncoming(dm(ADMIN, "/diam 2j"), outbox);
    assert.match(sent[0].text!, /Kirim \/diam di grup/);
    await handleIncoming(inGroup(ADMIN, "/diam lama"), outbox);
    assert.match(sent[1].text!, /Format: \/diam/);
  });

  it("/status reports health and cost to the admin only", async () => {
    await handleIncoming(inGroup(ADMIN, "/status"), outbox);
    assert.equal(sent[0].chatId, private_(ADMIN.number));
    assert.match(sent[0].text!, /Status Friday[\s\S]*Versi: [\s\S]*Hari ini: <?\$[\d,]+ ≈ Rp/);
  });

  it("/backup sends the admin a working copy of the database", async () => {
    await handleIncoming(dm(ADMIN, "/backup"), outbox);
    assert.equal(sent[0].chatId, private_(ADMIN.number));
    assert.match(sent[0].file!, /^friday-backup-\d{4}-\d\d-\d\d\.db$/);
    assert.equal(sent[0].data!.subarray(0, 15).toString(), "SQLite format 3");
  });

  it("keeps these commands from everyone else", async () => {
    const friend = { name: "Budi", number: "6283333333333" }; // a fresh daily message quota (3 in tests)
    for (const command of ["/stop", "/backup"]) {
      answer("Hmm?");
      await handleIncoming(dm(friend, command), outbox);
    }
    assert.equal(claude.requests.length, 2, "they go to Claude as ordinary text");
    assert.ok(sent.every((s) => s.chatId === private_(friend.number) && s.text === "Hmm?"));
    answer("Masih aktif");
    await handleIncoming(dm(friend, "halo"), outbox);
    assert.equal(sent.at(-1)!.text, "Masih aktif", "her /stop didn't stop anything");
  });

  it("/style changes how Friday talks in that chat from the next message, keeping the conversation's context", async () => {
    const system = () => JSON.stringify(claude.requests.at(-1)!.body.system);
    answer("Siap.");
    await handleIncoming(inGroup(ADMIN, "Friday, kita ke Bali yuk"), outbox);
    assert.doesNotMatch(system(), /# Style/);

    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/style ngeyel"), outbox);
    assert.equal(sent[0].chatId, private_(ADMIN.number));
    assert.match(sent[0].text!, /\*Kongkow\* sekarang \*ngeyel\*/);
    answer("Eits, belum tentu Bali!");
    await handleIncoming(inGroup(ADMIN, "Friday, Bali paling seru kan?"), outbox);
    assert.match(system(), /devil's advocate/);
    assert.match(system(), /Earlier in this chat[\s\S]*kita ke Bali yuk/, "the earlier talk carries over as a recap");

    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, "/status"), outbox);
    assert.match(sent[0].text!, /Gaya khusus\*\n- Kongkow: ngeyel/);

    answer("Halo.");
    await handleIncoming(dm(ADMIN, "halo"), outbox);
    assert.doesNotMatch(system(), /# Style/, "other chats keep the normal voice");

    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/style"), outbox);
    assert.match(sent[0].text!, /\*ngeyel\*[\s\S]*Pilihan: chill, formal, funny, ngeyel, normal/);
    await handleIncoming(inGroup(ADMIN, "/style galak"), outbox);
    assert.match(sent[1].text!, /tidak ada/);
    await handleIncoming(inGroup(ADMIN, "/style normal"), outbox);
    answer("Oke.");
    await handleIncoming(inGroup(ADMIN, "Friday, jadi ke Bali"), outbox);
    assert.doesNotMatch(system(), /# Style/);
  });

  it("only the admin can change the style", async () => {
    const friend = { name: "Dina", number: "6284444444444" };
    answer("Hmm?");
    await handleIncoming(inGroup(friend, "/style ngeyel"), outbox);
    assert.equal(claude.requests.length, 1, "it went to Claude as ordinary text");
    answer("Oke.");
    await handleIncoming(inGroup(friend, "Friday, halo"), outbox);
    assert.doesNotMatch(JSON.stringify(claude.requests.at(-1)!.body.system), /# Style/);
  });

  it("reads durations in Indonesian and English shorthand", () => {
    assert.equal(parseDuration(""), 3600_000);
    assert.equal(parseDuration("30m"), 30 * 60_000);
    assert.equal(parseDuration("2j"), 2 * 3600_000);
    assert.equal(parseDuration("1,5 jam"), 1.5 * 3600_000);
    assert.equal(parseDuration("3h"), 3 * 24 * 3600_000);
    assert.equal(parseDuration("30 hari"), 7 * 24 * 3600_000, "at most a week");
    assert.equal(parseDuration("lama"), undefined);
    assert.equal(duration(93_784_000), "1 hari 2 jam 3 menit");
    assert.equal(duration(1000), "kurang dari 1 menit");
  });
});
