import { ADMIN, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { aesEncryptGCM, hmacSign, proto, sha256 } from "baileys";
import { pollInChat, recordVote } from "../src/polls.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { readVote } from "../src/whatsapp.js";

const polls: { chatId: string; question: string; options: string[]; multiple: boolean }[] = [];
let nextMsg = 1;
const outbox: Outbox = {
  async sendText() {},
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
  async sendPoll(chatId, poll) {
    polls.push({ chatId, ...poll });
    return { messageId: `POLL${nextMsg++}`, secret: randomBytes(32) };
  },
  async groupSize() {
    return 6;
  },
};

const group = (who: { name: string; number: string }, isContact = true, chatId = "kongkow@g.us"): ChatContext => ({
  chatId,
  isGroup: true,
  chatName: "Kongkow",
  sender: { ...who, isContact },
});
const RINA = { name: "Rina", number: "6283333333333" };

/** Encrypts a vote the way WhatsApp does (the reverse of Baileys' decryptPollVote). */
function encryptVote(options: string[], secret: Buffer, msgId: string, creatorJid: string, voterJid: string) {
  const sign = Buffer.concat([Buffer.from(msgId), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from("Poll Vote"), new Uint8Array([1])]);
  const key = hmacSign(sign, hmacSign(secret, new Uint8Array(32), "sha256"), "sha256");
  const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: options.map((o) => sha256(Buffer.from(o))) }).finish();
  const encIv = randomBytes(12);
  return { encPayload: aesEncryptGCM(plain, key, encIv, Buffer.from(`${msgId}\u0000${voterJid}`)), encIv };
}

describe("polls", () => {
  it("reads a vote whichever ids WhatsApp encrypted it for", () => {
    const poll = { id: 1, msg_id: "ABC123", chat_id: "g@g.us", question: "Kongkow?", options: ["✅ Ikut", "❌ Gak bisa"], secret: randomBytes(32), created_at: 0 };
    const me = ["6281775741000@s.whatsapp.net", "111222333@lid"];
    const voter = ["6283333333333@s.whatsapp.net", "999888777@lid"];
    // Encrypted for the LIDs, while the phone-number ids are tried first.
    const vote = encryptVote(["❌ Gak bisa"], poll.secret, poll.msg_id, me[1], voter[1]);
    assert.deepEqual(readVote(vote, poll, me, voter), ["❌ Gak bisa"]);
    assert.equal(readVote(vote, { ...poll, secret: randomBytes(32) }, me, voter), undefined, "another poll's secret can't read it");
    assert.deepEqual(readVote(encryptVote([], poll.secret, poll.msg_id, me[0], voter[0]), poll, me, voter), [], "a withdrawn vote");
  });

  it("lets a contact send a poll and reports who chose what, without naming who hasn't voted", async () => {
    const created = await runTool(
      "create_poll",
      { question: "Kongkow Sabtu 19.00 · Kopi Kenangan", options: ["✅ Ikut", "❌ Gak bisa", "🤔 Belum tahu", "✅ Ikut"] },
      { chat: group(WIFE), outbox },
    );
    assert.equal(created.isError, false, created.content);
    assert.deepEqual(polls.at(-1), {
      chatId: "kongkow@g.us",
      question: "Kongkow Sabtu 19.00 · Kopi Kenangan",
      options: ["✅ Ikut", "❌ Gak bisa", "🤔 Belum tahu"],
      multiple: false,
    });

    const poll = pollInChat("kongkow@g.us")!;
    recordVote(poll.id, ADMIN.number, "Albert WA", ["✅ Ikut"]);
    recordVote(poll.id, RINA.number, "Rina", ["🤔 Belum tahu"]);
    recordVote(poll.id, RINA.number, undefined, ["✅ Ikut"]); // changed her mind; keeps her name
    recordVote(poll.id, "6284444444444", "Budi", ["❌ Gak bisa"]);
    recordVote(poll.id, "6284444444444", undefined, []); // took the vote back

    const { content } = await runTool("poll_results", {}, { chat: group(ADMIN), outbox });
    assert.match(content, /- ✅ Ikut \(2\): Albert, Rina/, "contacts by their contact name, others by their WhatsApp name");
    assert.match(content, /- ❌ Gak bisa \(0\)\n/);
    assert.match(content, /Not voted yet: 4 of 6 members/);
    assert.doesNotMatch(content, /Sarah|Budi/);
  });

  it("keeps polls to their own chat and only lets contacts create them", async () => {
    const elsewhere = await runTool("poll_results", {}, { chat: group(ADMIN, true, "other@g.us"), outbox });
    assert.equal(elsewhere.content, "No poll has been sent in this chat yet.");
    const stranger = await runTool("create_poll", { question: "Spam?", options: ["a", "b"] }, { chat: group(RINA, false), outbox });
    assert.equal(stranger.isError, true);
    assert.match(stranger.content, /Only known contacts/);
  });
});
