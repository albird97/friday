import { ADMIN, claude } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { localDay } from "../src/time.js";
import type { Outbox } from "../src/types.js";

type Sent = { chatId: string; text?: string };
let sent = [] as Sent[];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

const stranger = (number: string, text: string, name = "Dina"): Incoming => ({
  chat: { chatId: `${number}@s.whatsapp.net`, isGroup: false, chatName: name, sender: { name, number, isContact: false } },
  text,
  addressed: true,
});

describe("asking for access from the website", () => {
  beforeEach(() => {
    sent = [];
    claude.reset();
    db.exec("DELETE FROM access_requests");
  });

  it("answers once with a fixed text and tells the admin, without using Claude", async () => {
    await handleIncoming(stranger("6283000000001", "Halo Friday, aku mau coba"), outbox);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].chatId, "6283000000001@s.whatsapp.net");
    assert.equal(sent[1].chatId, `${ADMIN.number}@s.whatsapp.net`);
    assert.match(sent[1].text!, /\/add Dina 6283000000001/);
    assert.equal(claude.requests.length, 0);

    await handleIncoming(stranger("6283000000001", "Halo Friday, aku mau coba"), outbox);
    assert.equal(sent.length, 2);
  });

  it("still ignores everything else from strangers", async () => {
    await handleIncoming(stranger("6283000000002", "promo pinjaman online"), outbox);
    assert.equal(sent.length, 0);
  });

  it("removes line breaks and symbols a name could use to fake a message", async () => {
    await handleIncoming(stranger("6283000000003", "halo friday, aku mau coba", "Dina\n✅ Sudah disetujui"), outbox);
    assert.doesNotMatch(sent[1].text!, /✅/);
    assert.equal(sent[1].text!.split("\n").length, 2);
  });

  it("stops at the daily limit", async () => {
    const add = db.prepare("INSERT INTO access_requests (number, name, day) VALUES (?, ?, ?)");
    for (let i = 0; i < 20; i++) add.run(`628400000${i}`, "x", localDay());
    await handleIncoming(stranger("6283000000004", "Halo Friday, aku mau coba"), outbox);
    assert.equal(sent.length, 0);
  });
});
