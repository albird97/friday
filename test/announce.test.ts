import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { announce } from "../src/announce.js";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { addContact, removeContact } from "../src/contacts.js";
import type { Outbox } from "../src/types.js";

type Sent = { chatId: string; text?: string };
let sent = [] as Sent[];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile(chatId) {
    sent.push({ chatId });
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
const answer = (t: string) => claude.replies.push({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const lastUserTurn = () => JSON.stringify(claude.requests.at(-1)!.body.messages.at(-1));

beforeEach(() => {
  claude.reset();
  sent = [];
});

describe("/umumkan", () => {
  it("sends the text as is, with no label and without Claude, then reports to the admin", async () => {
    const text = "*Fitur baru!*\n\nFriday sekarang bisa baca foto.";
    await handleIncoming(dm(ADMIN, `/umumkan ${text}`), outbox);

    assert.deepEqual(sent.filter((m) => m.chatId === private_(WIFE.number)).map((m) => m.text), [text]);
    assert.ok(sent.some((m) => m.chatId === private_(ADMIN.number) && /terkirim ke \*1\* dari 1 kontak/.test(m.text!)));
    assert.equal(sent.filter((m) => m.text === text).length, 1, "the admin doesn't get a copy");
    assert.equal(claude.requests.length, 0);
  });

  it("tells Friday once, on the person's next message, so it understands replies", async () => {
    await handleIncoming(dm(ADMIN, "/umumkan Friday sekarang bisa membuat polling"), outbox);

    answer("Iya, tinggal minta saja.");
    await handleIncoming(dm(WIFE, "maksudnya gimana?"), outbox);
    assert.match(lastUserTurn(), /System note[^"]*already sent[^"]*Friday sekarang bisa membuat polling/);

    answer("Sama-sama!");
    await handleIncoming(dm(WIFE, "makasih"), outbox);
    assert.doesNotMatch(lastUserTurn(), /System note/);
  });

  it("sends nothing from a group, without text, or with an attachment", async () => {
    const group: Incoming = { ...dm(ADMIN, "/umumkan Halo semua"), chat: { ...dm(ADMIN, "").chat, chatId: GROUP, isGroup: true, chatName: "Kongkow" } };
    const photo: Incoming = { ...dm(ADMIN, "/umumkan Lihat ini"), media: { kind: "image", mimetype: "image/png", download: async () => Buffer.alloc(0) } };
    for (const incoming of [group, photo, dm(ADMIN, "/umumkan   ")]) await handleIncoming(incoming, outbox);

    assert.equal(sent.length, 3);
    assert.ok(sent.every((m) => m.chatId === private_(ADMIN.number) && /Kirim dari chat pribadi/.test(m.text!)));
  });

  it("is ordinary text from anyone else", async () => {
    const friend = { name: "Budi", number: "6283333333333" };
    answer("Hmm?");
    await handleIncoming(dm(friend, "/umumkan Halo semua"), outbox);
    assert.equal(claude.requests.length, 1);
    assert.deepEqual(sent, [{ chatId: private_(friend.number), text: "Hmm?" }]);
  });

  it("keeps going past a failed contact, spaces the sends out, and names who failed", async () => {
    const wrong = addContact("Salah Nomor", "6285100000001");
    const flaky = addContact("Gagal Kirim", "6285100000002");
    const fine = addContact("Budi", "6285100000003");
    const shaky: Outbox = {
      ...outbox,
      isOnWhatsApp: async (number) => number !== wrong.number,
      async sendText(chatId, text) {
        if (chatId === private_(flaky.number)) throw new Error("timed out");
        sent.push({ chatId, text });
      },
    };

    const started = Date.now();
    const report = await announce("Halo", shaky, 20);
    assert.ok(Date.now() - started >= 55, "three gaps between four contacts");
    assert.deepEqual(sent.map((m) => m.chatId), [private_(WIFE.number), private_(fine.number)]);
    assert.match(report, /terkirim ke \*2\* dari 4 kontak/);
    assert.match(report, /Salah Nomor \(\+6285100000001\): tidak terdaftar di WhatsApp/);
    assert.match(report, /Gagal Kirim \(\+6285100000002\): timed out/);

    answer("Halo juga.");
    await handleIncoming(dm(flaky, "halo"), outbox);
    assert.doesNotMatch(lastUserTurn(), /System note/, "only people who got it are noted");
    for (const c of [wrong, flaky, fine]) removeContact(c.number);
  });
});
