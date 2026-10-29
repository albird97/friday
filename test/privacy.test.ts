import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { short } from "../src/usage.js";
import type { Outbox } from "../src/types.js";

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

const chatOf = (who: { number: string }) => `${who.number}@s.whatsapp.net`;
const dm = (from: { name: string; number: string }, text: string): Incoming => ({
  chat: { chatId: chatOf(from), isGroup: false, chatName: from.name, sender: { ...from, isContact: true } },
  text,
  addressed: true,
});
const inGroup = (from: { name: string; number: string }, text: string): Incoming => ({
  chat: { chatId: "family@g.us", isGroup: true, chatName: "Family", sender: { ...from, isContact: true } },
  text,
  addressed: true,
});
const reply = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

beforeEach(() => {
  claude.reset();
  sent = [];
});

describe("privacy of who uses Friday", () => {
  // Sarah's daily limit in the tests is 3 messages, so this one runs first.
  it("gives the contact list only to the admin's private chat", async () => {
    claude.replies.push(reply("a"), reply("b"), reply("c"));
    await handleIncoming(dm(ADMIN, "siapa saja kontakmu?"), outbox);
    await handleIncoming(dm(WIFE, "siapa saja kontakmu?"), outbox);
    await handleIncoming(inGroup(ADMIN, "Friday, siapa saja kontakmu?"), outbox);
    const [admin, wife, group] = claude.requests.map((r) => JSON.stringify(r.body.system));
    assert.match(admin, /admin's eyes only: Albert, Sarah/);
    for (const prompt of [wife, group]) {
      assert.doesNotMatch(prompt, /Known contacts/);
      assert.match(prompt, /you don't share who else uses you/);
    }
    assert.doesNotMatch(wife, /Albert/, "not even as an example name");
  });

  it("records tokens per person and reports them to the admin only, always privately", async () => {
    claude.replies.push(reply("Hi Albert"), reply("Hi Sarah"));
    await handleIncoming(dm(ADMIN, "hi"), outbox);
    await handleIncoming(dm(WIFE, "hi"), outbox);

    sent = [];
    await handleIncoming(inGroup(ADMIN, "/usage"), outbox);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, chatOf(ADMIN), "never answered in the group");
    assert.match(sent[0].text!, /Pemakaian token Claude per orang/);
    // The fake API reports 100 input + 20 output tokens per request.
    assert.match(sent[0].text!, new RegExp(`- Albert \\(\\+${ADMIN.number}\\): \\*\\d+\\*`));
    assert.match(sent[0].text!, new RegExp(`- Sarah \\(\\+${WIFE.number}\\): \\*\\d+\\*`));

    // For anyone else /usage and /contacts are just text to Claude, which has no such data.
    sent = [];
    claude.replies.push(reply("Maaf, itu bukan perintah yang saya kenal."), reply("Maaf, saya tidak bisa membagikan itu."));
    await handleIncoming(dm(WIFE, "/usage"), outbox);
    await handleIncoming(dm(WIFE, "/contacts"), outbox);
    assert.equal(sent.some((s) => s.text?.includes("Pemakaian token") || s.text?.includes(ADMIN.number)), false);
  });

  it("abbreviates token counts", () => {
    assert.equal(short(950), "950");
    assert.equal(short(15_400), "15rb");
    assert.equal(short(2_450_000), "2,5jt");
  });
});
