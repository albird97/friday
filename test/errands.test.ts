import "./errands-env.js";
import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
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
  isOnWhatsApp: async (n) => !n.startsWith("6221"), // Jakarta landlines aren't on WhatsApp
};

const RESTO = { name: "Sate Senayan", number: "6285555555555" };
const chatOf = (who: { number: string }) => `${who.number}@s.whatsapp.net`;
function dm(from: { name: string; number: string }, text: string, isContact = true): Incoming {
  return { chat: { chatId: chatOf(from), isGroup: false, chatName: from.name, sender: { ...from, isContact } }, text, addressed: true };
}
const fromResto = (text: string) => dm(RESTO, text, false);
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolNames = (body: any) => (body.tools as any[]).map((t) => t.name);
const to = (who: { number: string }) => sent.filter((s) => s.chatId === chatOf(who)).map((s) => s.text);
const start = (id: string, extra: Record<string, unknown> = {}) =>
  toolUse(id, "start_errand", {
    to_number: RESTO.number,
    number_source: "Instagram @satesenayan (bio)",
    to_name: "Sate Senayan",
    goal: "Book a table for 4 on Saturday 31 Oct at 19:00 under the name Albert.",
    first_message: "Halo, saya Albert. Mau reservasi meja untuk 4 orang Sabtu 31 Okt jam 19.00, bisa?",
    ...extra,
  });

beforeEach(() => {
  claude.reset();
  sent = [];
});

describe("errands", () => {
  it("are offered only to ERRAND_USERS in private chats", async () => {
    claude.replies.push(
      { content: [text("hi")], stop_reason: "end_turn" },
      { content: [text("hi")], stop_reason: "end_turn" },
      { content: [text("hi")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "hi"), outbox);
    await handleIncoming(dm(WIFE, "hi"), outbox);
    await handleIncoming({ ...dm(ADMIN, "Friday, hi"), chat: { ...dm(ADMIN, "").chat, chatId: "fam@g.us", isGroup: true } }, outbox);
    const [admin, wife, group] = claude.requests.map((r) => r.body);
    assert.ok(toolNames(admin).includes("start_errand"));
    assert.match(JSON.stringify(admin.system), /Errands with people who aren't contacts/);
    for (const body of [wife, group]) assert.equal(toolNames(body).includes("start_errand"), false);
  });

  it("runs a reservation end to end: confirm, send, reply, ask, answer, finish", async () => {
    // 1. Albert asks; Claude proposes the errand. Nothing reaches the restaurant yet.
    claude.replies.push({ content: [start("tu_1")], stop_reason: "tool_use" }, { content: [text("Cek dulu ya.")], stop_reason: "end_turn" });
    await handleIncoming(dm(ADMIN, "tolong reservasi di Sate Senayan 085555555555 sabtu jam 7 buat 4 orang"), outbox);
    const confirmation = to(ADMIN).find((t) => t?.startsWith("📤"))!;
    assert.match(confirmation, /Kirim pesan ke Sate Senayan \(\+6285555555555\)\?\*\nNomor dari: Instagram @satesenayan \(bio\)\n/);
    assert.match(confirmation, /Pesan pertama \(atas nama Albert\):\nHalo, saya Albert\./);
    const code = /YA (\d{4})/.exec(confirmation)![1];
    assert.deepEqual(to(RESTO), []);

    // 2. Albert confirms: the first message goes out, without asking Claude.
    sent = [];
    const before = claude.requests.length;
    await handleIncoming(dm(ADMIN, `YA ${code}`), outbox);
    assert.deepEqual(to(RESTO), ["Halo, saya Albert. Mau reservasi meja untuk 4 orang Sabtu 31 Okt jam 19.00, bisa?"]);
    assert.match(to(ADMIN)[0]!, /^✅ Terkirim ke Sate Senayan/);
    assert.equal(claude.requests.length, before);

    // 3. The restaurant answers; Friday replies within the brief, with a narrow tool set, mirrored to Albert.
    sent = [];
    claude.replies.push({ content: [text("Atas nama Albert, 4 orang ya kak.")], stop_reason: "end_turn" });
    await handleIncoming(fromResto("Bisa kak, atas nama siapa?"), outbox);
    const errandRequest = claude.requests.at(-1)!.body;
    assert.deepEqual(toolNames(errandRequest), ["ask_requester", "finish_errand"]);
    assert.match(JSON.stringify(errandRequest.system), /Book a table for 4 on Saturday/);
    assert.match(JSON.stringify(errandRequest.system), /Write as Albert, in the first person/);
    assert.match(JSON.stringify(errandRequest.system), /sincerely ask whether they're chatting with a bot.*don't deny it/);
    assert.deepEqual(to(RESTO), ["Atas nama Albert, 4 orang ya kak."]);
    assert.deepEqual(to(ADMIN), ["💬 *Sate Senayan:* Bisa kak, atas nama siapa?", "↪️ *Ke Sate Senayan:*\nAtas nama Albert, 4 orang ya kak."]);

    // 4. Something outside the brief: Friday asks Albert instead of agreeing.
    sent = [];
    claude.replies.push(
      { content: [toolUse("tu_2", "ask_requester", { question: "Mereka minta DP Rp100.000. Setuju?" })], stop_reason: "tool_use" },
      { content: [text("Baik kak, saya konfirmasi dulu ya.")], stop_reason: "end_turn" },
    );
    await handleIncoming(fromResto("Untuk Sabtu perlu DP 100rb kak"), outbox);
    assert.ok(to(ADMIN).includes("❓ *Sate Senayan* — Mereka minta DP Rp100.000. Setuju?\n_Balas di sini, nanti saya teruskan._"));

    // 5. Albert answers in his own chat; Claude there sees the note and passes it on.
    sent = [];
    const errandId = (db.prepare("SELECT id FROM errands ORDER BY id DESC").get() as { id: number }).id;
    claude.replies.push(
      { content: [toolUse("tu_3", "errand_reply", { errand_id: errandId, message: "Setuju DP, minta nomor rekeningnya." })], stop_reason: "tool_use" },
      { content: [text("Boleh, kirim nomor rekeningnya ya kak.")], stop_reason: "end_turn" },
      { content: [text("Sudah saya sampaikan.")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "ok setuju DP"), outbox);
    const mainTurn = claude.requests.at(-3)!.body.messages.at(-1).content;
    assert.match(mainTurn[0].text, /System note — errands:.*asks: Mereka minta DP.*errand_id/s);
    const relayed = claude.requests.at(-2)!.body.messages.at(-1).content[0].text;
    assert.match(relayed, /from Albert \(your principal; Sate Senayan can't see this\): Setuju DP/);
    assert.deepEqual(to(RESTO), ["Boleh, kirim nomor rekeningnya ya kak."]);

    // 6. Settled: the outcome is reported to Albert and the errand closes.
    sent = [];
    claude.replies.push(
      { content: [text("Terima kasih kak!"), toolUse("tu_4", "finish_errand", { result: "Meja 4 orang Sabtu 31 Okt 19.00 a.n. Albert, DP Rp100.000 ke BCA 123." })], stop_reason: "tool_use" },
      { content: [], stop_reason: "end_turn" },
    );
    await handleIncoming(fromResto("Sudah kami catat ya kak, rekening BCA 123"), outbox);
    assert.ok(to(ADMIN).includes("📋 *Selesai — Sate Senayan:* Meja 4 orang Sabtu 31 Okt 19.00 a.n. Albert, DP Rp100.000 ke BCA 123."));
    assert.equal((db.prepare("SELECT status FROM errands WHERE id = ?").get(errandId) as { status: string }).status, "done");
  });

  it("ignores strangers who have no errand", async () => {
    await handleIncoming(dm({ name: "Spam", number: "6289999999999" }, "promo!", false), outbox);
    assert.equal(claude.requests.length, 0);
    assert.deepEqual(sent, []);
  });

  it("refuses bad targets, enforces the daily limit, and expires unused codes", async () => {
    const attempt = async (input: Record<string, unknown>) => {
      claude.reset();
      claude.replies.push({ content: [start("tu_x", input)], stop_reason: "tool_use" }, { content: [text("ok")], stop_reason: "end_turn" });
      await handleIncoming(dm(ADMIN, "errand"), outbox);
      return claude.requests[1].body.messages.at(-1).content[0];
    };
    assert.match((await attempt({ to_number: "085555555555" })).content, /country code/);
    assert.match((await attempt({ to_number: WIFE.number })).content, /known contact; use send_message/);
    assert.match((await attempt({ to_number: "62215551234" })).content, /isn't on WhatsApp \(often a landline\)/);

    // The previous test used one of today's two errands; this is the second, the third is refused.
    const second = await attempt({ to_number: "6286666666666" });
    assert.equal(second.is_error, undefined);
    assert.match((await attempt({ to_number: "6287777777777" })).content, /limit of 2 new errands a day/);

    const code = (db.prepare("SELECT code FROM errands WHERE target_number = '6286666666666'").get() as { code: string }).code;
    db.prepare("UPDATE errands SET created_at = ? WHERE target_number = '6286666666666'").run(Date.now() - 11 * 60_000);
    sent = [];
    await handleIncoming(dm(ADMIN, `YA ${code}`), outbox);
    assert.match(to(ADMIN)[0]!, /kedaluwarsa/);
    assert.deepEqual(to({ number: "6286666666666" }), []);
  });
});
