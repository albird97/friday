import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { runTool, toolsFor } from "../src/tools.js";
import { currentModel, newestOf } from "../src/model.js";
import { parseDuration } from "../src/pause.js";
import { duration } from "../src/status.js";
import { findContact } from "../src/contacts.js";
import { imagesEnabled } from "../src/images.js";
import type { Outbox } from "../src/types.js";
import { welcomeMessage } from "../src/welcome.js";

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

  it("/switch semua moves every chat to the newest version of a model family", async () => {
    answer("Halo.");
    await handleIncoming(dm(ADMIN, "halo sebelum ganti"), outbox);
    assert.equal(claude.requests.at(-1)!.body.model, "claude-opus-5-5");

    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/switch semua sonnet"), outbox);
    assert.equal(sent[0].chatId, private_(ADMIN.number));
    assert.match(sent[0].text!, /Semua chat sekarang memakai \*claude-sonnet-5-5\*/);

    for (const incoming of [dm(ADMIN, "halo lagi"), inGroup({ name: "Fani", number: "6287777777777" }, "Friday, halo")]) {
      answer("Halo.");
      await handleIncoming(incoming, outbox);
      assert.equal(claude.requests.at(-1)!.body.model, "claude-sonnet-5-5", "private and group, admin or not");
    }
    assert.match(JSON.stringify(claude.requests.at(-2)!.body.system), /Earlier in this chat[\s\S]*halo sebelum ganti/, "a chat carries on from a recap");

    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, "/switch semua"), outbox);
    assert.match(sent[0].text!, /Model semua chat: \*claude-sonnet-5-5\*[\s\S]*Pilihan: opus, sonnet, haiku/);
    await handleIncoming(dm(ADMIN, "/switch semua gemini"), outbox);
    assert.match(sent[1].text!, /tidak ada/);
    await handleIncoming(dm(ADMIN, "/switch semua sonnet"), outbox);
    assert.match(sent[2].text!, /sudah memakai/);
    assert.equal(currentModel(), "claude-sonnet-5-5");

    await handleIncoming(dm(ADMIN, "/switch semua haiku"), outbox);
    assert.equal(currentModel(), "claude-haiku-5-5");
    await handleIncoming(dm(ADMIN, "/switch semua opus"), outbox);
    assert.equal(currentModel(), "claude-opus-5-5");
  });

  it("/switch in a group changes only that group, until /switch default", async () => {
    const other = { ...inGroup(ADMIN, "Friday, halo"), chat: { ...inGroup(ADMIN, "").chat, chatId: "120363000000000002@g.us", chatName: "Keluarga" } };
    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/switch haiku"), outbox);
    assert.equal(sent[0].chatId, private_(ADMIN.number), "the group sees nothing");
    assert.match(sent[0].text!, /\*Kongkow\* sekarang memakai \*claude-haiku-5-5\*/);

    for (const [incoming, model] of [[inGroup(ADMIN, "Friday, halo"), "claude-haiku-5-5"], [other, "claude-opus-5-5"], [dm(ADMIN, "halo"), "claude-opus-5-5"]] as const) {
      answer("Halo.");
      await handleIncoming(incoming, outbox);
      assert.equal(claude.requests.at(-1)!.body.model, model);
    }

    await handleIncoming(inGroup(ADMIN, "/switch semua sonnet"), outbox);
    answer("Halo.");
    await handleIncoming(inGroup(ADMIN, "Friday, halo"), outbox);
    assert.equal(claude.requests.at(-1)!.body.model, "claude-haiku-5-5", "its own choice outlasts a change for everyone");

    sent = [] as Sent[];
    await handleIncoming(inGroup(ADMIN, "/switch"), outbox);
    assert.match(sent[0].text!, /Model di \*Kongkow\*: \*claude-haiku-5-5\*\nDefault semua chat: \*claude-sonnet-5-5\*/);
    await handleIncoming(inGroup(ADMIN, "/switch default"), outbox);
    assert.match(sent[1].text!, /kembali ikut model default, \*claude-sonnet-5-5\*/);
    answer("Halo.");
    await handleIncoming(inGroup(ADMIN, "Friday, halo"), outbox);
    assert.equal(claude.requests.at(-1)!.body.model, "claude-sonnet-5-5");
    await handleIncoming(dm(ADMIN, "/switch semua opus"), outbox);
  });

  it("people in SWITCH_USERS can switch their own private chat, and nowhere else", async () => {
    const HANA = { name: "Hana", number: "6286666666666" };
    sent = [] as Sent[];
    await handleIncoming(dm(HANA, "/switch sonnet"), outbox);
    assert.equal(sent[0].chatId, private_(HANA.number));
    assert.match(sent[0].text!, /Chat ini sekarang memakai \*claude-sonnet-5-5\*/);
    answer("Halo.");
    await handleIncoming(dm(HANA, "halo"), outbox);
    assert.equal(claude.requests.at(-1)!.body.model, "claude-sonnet-5-5");
    answer("Halo.");
    await handleIncoming(dm(ADMIN, "halo"), outbox);
    assert.equal(claude.requests.at(-1)!.body.model, "claude-opus-5-5", "nobody else's chat changes");

    sent = [] as Sent[];
    await handleIncoming(dm(HANA, "/switch"), outbox);
    assert.match(sent[0].text!, /Model di chat ini: \*claude-sonnet-5-5\*\nPilihan/, "no word about everyone else's default");
    answer("Hmm?");
    await handleIncoming(dm(HANA, "/switch semua haiku"), outbox);
    assert.equal(currentModel(), "claude-opus-5-5", "only the admin changes every chat");
    answer("Hmm?");
    await handleIncoming(inGroup(HANA, "/switch haiku"), outbox);
    assert.equal(currentModel(GROUP), "claude-opus-5-5", "not in groups");
    await handleIncoming(dm(HANA, "/switch default"), outbox);
    assert.equal(currentModel(private_(HANA.number)), "claude-opus-5-5");
  });

  it("nobody else can switch models", async () => {
    const gita = { name: "Gita", number: "6288888888888" };
    answer("Hmm?");
    await handleIncoming(dm(gita, "/switch haiku"), outbox);
    assert.equal(currentModel(private_(gita.number)), "claude-opus-5-5");
    assert.equal(sent[0].text, "Hmm?");
  });

  it("picks a family's highest version, whatever order the API lists them in", () => {
    const ids = ["claude-opus-4-8", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-5-20251101", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"];
    assert.equal(newestOf("opus", ids), "claude-opus-5-5");
    assert.equal(newestOf("opus", [...ids, "claude-opus-6"]), "claude-opus-6");
    assert.equal(newestOf("haiku", ids), "claude-haiku-4-5-20251001");
    assert.equal(newestOf("sonnet", ["claude-opus-5"]), undefined);
  });

  it("lets the admin post in a group, found by name, and nobody else", async () => {
    const withGroups: Outbox = {
      ...outbox,
      groups: async () => [
        { id: GROUP, name: "Kongkow" },
        { id: "2@g.us", name: "Keluarga Besar" },
        { id: "3@g.us", name: "Keluarga Inti" },
      ],
    };
    const post = (from: { name: string; number: string }, group: string, text = "Halo semua") =>
      runTool("send_group_message", { group, text }, { chat: dm(from, "").chat, outbox: withGroups });

    assert.match((await post(ADMIN, "keluarga inti")).content, /Posted in Keluarga Inti/);
    assert.deepEqual(sent, [{ chatId: "3@g.us", text: "Halo semua" }]);
    assert.match((await post(ADMIN, "kong")).content, /Posted in Kongkow/);
    assert.equal(sent.at(-1)!.chatId, GROUP);

    sent = [] as Sent[];
    const ambiguous = await post(ADMIN, "keluarga");
    assert.ok(ambiguous.isError);
    assert.match(ambiguous.content, /Keluarga Besar, Keluarga Inti/);
    const unknown = await post(ADMIN, "kantor");
    assert.ok(unknown.isError);
    assert.match(unknown.content, /My groups: Kongkow, Keluarga Besar, Keluarga Inti/);

    const stranger = await post(WIFE, "Kongkow");
    assert.ok(stranger.isError);
    assert.doesNotMatch(stranger.content, /Keluarga/, "others don't learn which groups Friday is in");
    assert.equal(sent.length, 0);

    const here = await runTool("send_group_message", { group: "Kongkow", text: "x" }, { chat: inGroup(ADMIN, "").chat, outbox: withGroups });
    assert.match(here.content, /this chat/);
    assert.equal(sent.length, 0);

    const offered = async (from: { name: string; number: string }) => JSON.stringify(await toolsFor(dm(from, "").chat));
    assert.match(await offered(ADMIN), /send_group_message/);
    assert.doesNotMatch(await offered(WIFE), /send_group_message/);
  });

  it("/help shows the admin every command, and nobody else the admin ones", async () => {
    const source = fs.readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
    const aliases = new Set(["/help", "/new", "/catalog"]);
    const commands = [...source.matchAll(/case "(\/\w+)"/g)].map((m) => m[1]).filter((c) => !aliases.has(c));
    assert.ok(commands.length >= 15);
    await handleIncoming(dm(ADMIN, "/help"), outbox);
    for (const command of commands) assert.match(sent[0].text!, new RegExp(`${command}\\b`), `${command} is missing from /help`);

    await handleIncoming(inGroup(ADMIN, "/help"), outbox);
    await handleIncoming(dm({ name: "Eko", number: "6285555555555" }, "/help"), outbox);
    for (const reply of sent.slice(1)) assert.doesNotMatch(reply.text!, /\/status|\/usage/);
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

describe("welcome message", () => {
  it("greets someone new from /add, without Claude, and tells the admin", async () => {
    const number = "6285100000001";
    await handleIncoming(dm(ADMIN, `/add Tante Rina ${number}`), outbox);

    const greeting = sent.find((m) => m.chatId === private_(number));
    assert.match(greeting!.text!, /Halo Tante Rina/);
    assert.ok(greeting!.text!.includes(`${ADMIN.name} baru saja memberi kamu akses`));
    const note = sent.find((m) => m.chatId === private_(ADMIN.number));
    assert.match(note!.text!, /Tante Rina.*\n.*sudah dikirim/);
    assert.equal(claude.requests.length, 0);
  });

  it("lists only what any contact can use, and never promises privacy", () => {
    const text = welcomeMessage("Budi");
    assert.doesNotMatch(text, /onehub|errand|reservasi|booking/i);
    assert.doesNotMatch(text, /hanya kamu|tidak ada yang bisa|rahasia|aman/i);
    assert.match(text, /asisten AI/);
    assert.match(text, /Batasnya 3 pesan per hari/);
    assert.equal(text.includes("gambar"), imagesEnabled);
  });

  it("doesn't greet someone again when /add only renames them", async () => {
    const number = "6285100000002";
    await handleIncoming(dm(ADMIN, `/add Budi ${number}`), outbox);
    sent = [] as Sent[];
    await handleIncoming(dm(ADMIN, `/add Pak Budi ${number}`), outbox);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, private_(ADMIN.number));
    assert.equal(findContact(number)?.name, "Pak Budi");
  });

  it("keeps the contact and warns the admin when the number isn't on WhatsApp", async () => {
    const number = "6285100000003";
    await handleIncoming(dm(ADMIN, `/add Salah Nomor ${number}`), { ...outbox, isOnWhatsApp: async () => false });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text!, /tidak terdaftar di WhatsApp/);
    assert.equal(findContact(number)?.name, "Salah Nomor");
  });

  it("keeps the contact and warns the admin when the greeting fails", async () => {
    const number = "6285100000004";
    const flaky: Outbox = {
      ...outbox,
      async sendText(chatId, text) {
        if (chatId === private_(number)) throw new Error("timed out");
        sent.push({ chatId, text });
      },
    };
    await handleIncoming(dm(ADMIN, `/add Gagal Kirim ${number}`), flaky);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text!, /gagal dikirim: timed out/);
    assert.equal(findContact(number)?.name, "Gagal Kirim");
  });
});
