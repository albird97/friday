import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import sharp from "sharp";
import { handleIncoming, type Incoming, type Media } from "../src/bot.js";
import { db } from "../src/db.js";
import { findContact } from "../src/contacts.js";
import { saveImage } from "../src/images.js";
import { runTool } from "../src/tools.js";
import type { Outbox } from "../src/types.js";

type Sent = { chatId: string; text?: string; file?: string; image?: boolean };
let sent: Sent[] = [];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile(chatId, file) {
    sent.push({ chatId, file: file.fileName });
  },
  async sendImage(chatId) {
    sent.push({ chatId, image: true });
  },
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

// Cloudflare image API stand-in; everything else (the Claude API) goes to the real fetch.
const cloudflareCalls: FormData[] = [];
const realFetch = globalThis.fetch;
const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes("api.cloudflare.com") && String(url).includes("whisper")) {
    const { audio } = JSON.parse(String(init?.body));
    const text = Buffer.from(audio, "base64").toString() === "voice" ? "Tolong ingatkan beli oli besok jam 7" : "";
    return new Response(JSON.stringify({ success: true, result: { text } }), { headers: { "content-type": "application/json" } });
  }
  if (String(url).includes("api.cloudflare.com")) {
    cloudflareCalls.push(init?.body as FormData);
    return new Response(JSON.stringify({ success: true, result: { image: generated.toString("base64") } }), {
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, init);
}) as typeof fetch;

function dm(from: { name: string; number: string }, text: string, media?: Media, isContact = true): Incoming {
  return {
    chat: { chatId: `${from.number}@s.whatsapp.net`, isGroup: false, chatName: from.name, sender: { ...from, isContact } },
    text,
    media,
    addressed: true,
  };
}

const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const lastUserText = (body: any) => body.messages.at(-1).content.findLast((b: any) => b.type === "text")?.text as string;

beforeEach(() => {
  claude.reset();
  sent = [];
  cloudflareCalls.length = 0;
});

describe("conversation flow", () => {
  it("runs tools, replies in WhatsApp format, and sends the right request", async () => {
    claude.replies.push(
      { content: [{ type: "thinking" }, toolUse("tu_1", "create_reminder", { text: "Call the bank", when: "2099-01-01T17:00" })], stop_reason: "tool_use" },
      { content: [text("Done! I'll remind you **at 17:00**.")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "remind me to call the bank at 5pm"), outbox);

    assert.deepEqual(sent, [{ chatId: `${ADMIN.number}@s.whatsapp.net`, text: "Done! I'll remind you *at 17:00*." }]);
    const reminder = db.prepare("SELECT text, chat_id FROM reminders WHERE text = 'Call the bank'").get() as { chat_id: string };
    assert.equal(reminder.chat_id, `${ADMIN.number}@s.whatsapp.net`);

    const [first, second] = claude.requests;
    assert.match(String(first.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.match(String(first.headers["anthropic-beta"]), /thinking-binding-controls-2026-08-01/);
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.equal(first.body.fallbacks, "default");
    assert.deepEqual(first.body.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    assert.deepEqual(first.body.output_config, { effort: "medium" });
    assert.ok(first.body.tools.some((t: any) => t.type === "web_search_20260209"));
    assert.match(lastUserText(first.body), /^\[.+\] Albert: remind me to call the bank at 5pm$/);

    // The second request replays the assistant turn (thinking included) and the tool result.
    assert.equal(second.body.messages.length, 3);
    assert.deepEqual(second.body.messages[1].content.map((b: any) => b.type), ["thinking", "tool_use"]);
    assert.equal(second.body.messages[2].content[0].type, "tool_result");
    assert.match(second.body.messages[2].content[0].content, /Created reminder/);
  });

  it("continues the same append-only session on the next message", async () => {
    claude.replies.push({ content: [text("You're welcome!")], stop_reason: "end_turn" });
    const before = db.prepare("SELECT system FROM sessions WHERE chat_id = ?").get(`${ADMIN.number}@s.whatsapp.net`) as { system: string };
    await handleIncoming(dm(ADMIN, "thanks"), outbox);
    const [req] = claude.requests;
    assert.equal(req.body.messages.length, 5);
    assert.equal(req.body.system, before.system); // unchanged prefix keeps the cache and thinking valid
  });

  it("creates and sends documents", async () => {
    claude.replies.push(
      { content: [toolUse("tu_2", "create_document", { format: "pdf", title: "Packing list", content: "- passport\n- charger" })], stop_reason: "tool_use" },
      { content: [text("Here's your list 📄")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(WIFE, "make me a packing list pdf"), outbox);
    assert.deepEqual(sent[0], { chatId: `${WIFE.number}@s.whatsapp.net`, file: "Packing list.pdf" });
  });

  it("generates an image, then edits a photo the user sent", async () => {
    claude.replies.push(
      { content: [toolUse("tu_3", "generate_image", { prompt: "a cat astronaut", aspect_ratio: "16:9" })], stop_reason: "tool_use" },
      { content: [text("Here you go!")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "draw a cat astronaut"), outbox);
    assert.equal(sent[0].image, true);
    assert.equal(cloudflareCalls[0].get("width"), "1360");
    assert.match(claude.requests[1].body.messages.at(-1).content[0].content, /Sent image #\d+/);

    const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "green" } }).jpeg().toBuffer();
    const media: Media = { kind: "image", mimetype: "image/jpeg", size: photo.length, download: async () => photo };
    claude.reset();
    claude.replies.push({ content: [text("placeholder")], stop_reason: "end_turn" });
    await handleIncoming(dm(ADMIN, "make the sky purple", media), outbox);
    const userTurn = claude.requests[0].body.messages.at(-1).content;
    assert.equal(userTurn[0].type, "image");
    const imageId = Number(/image #(\d+)/.exec(lastUserText(claude.requests[0].body))![1]);

    claude.replies.push(
      { content: [toolUse("tu_4", "edit_image", { image_ids: [imageId], instruction: "make the sky purple" })], stop_reason: "tool_use" },
      { content: [text("Purple sky ✨")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "go ahead"), outbox);
    const form = cloudflareCalls.at(-1)!;
    const ref = form.get("input_image_0") as Blob;
    const meta = await sharp(Buffer.from(await ref.arrayBuffer())).metadata();
    assert.ok(meta.width! <= 512 && meta.height! <= 512, "reference image is shrunk to 512px");
    assert.equal(form.get("width"), "1248"); // keeps the photo's 3:2 shape
  });
});

describe("access control and commands", () => {
  it("ignores private messages from strangers and unaddressed group chatter", async () => {
    await handleIncoming(dm({ name: "Spammer", number: "6287777777777" }, "hello?", undefined, false), outbox);
    await handleIncoming(
      { chat: { chatId: "123@g.us", isGroup: true, chatName: "Family", sender: { ...WIFE, isContact: true } }, text: "see you friday", addressed: false },
      outbox,
    );
    assert.equal(claude.requests.length, 0);
    assert.equal(sent.length, 0);
  });

  it("lets the admin add people from WhatsApp", async () => {
    await handleIncoming(dm(ADMIN, "/add Uncle Bob 6285555555555"), outbox);
    assert.equal(findContact("uncle bob")?.number, "6285555555555");
    assert.match(sent[0].text!, /Uncle Bob/);
    assert.equal(claude.requests.length, 0);
  });

  it("stops non-admins at the daily limit", async () => {
    const bob = { name: "Uncle Bob", number: "6285555555555" };
    for (let i = 0; i < 3; i++) claude.replies.push({ content: [text(`reply ${i}`)], stop_reason: "end_turn" });
    for (let i = 0; i < 4; i++) await handleIncoming(dm(bob, `message ${i}`), outbox);
    assert.equal(claude.requests.length, 3);
    assert.match(sent.at(-1)!.text!, /today's limit of 3/);
  });
});

describe("failures", () => {
  it("reports API errors and leaves the session as it was", async () => {
    const chatId = `${ADMIN.number}@s.whatsapp.net`;
    const before = (db.prepare("SELECT messages FROM sessions WHERE chat_id = ?").get(chatId) as { messages: string }).messages;
    claude.replies.push({ content: [], stop_reason: "end_turn", status: 400 });
    await handleIncoming(dm(ADMIN, "this will fail"), outbox);
    assert.match(sent[0].text!, /tripped me up/);
    assert.equal((db.prepare("SELECT messages FROM sessions WHERE chat_id = ?").get(chatId) as { messages: string }).messages, before);
  });

  it("handles refusals without storing them", async () => {
    const chatId = `${WIFE.number}@s.whatsapp.net`;
    const before = (db.prepare("SELECT messages FROM sessions WHERE chat_id = ?").get(chatId) as { messages: string }).messages;
    claude.replies.push({ content: [], stop_reason: "refusal" });
    await handleIncoming(dm(WIFE, "something disallowed"), outbox);
    assert.match(sent[0].text!, /can't help with that/);
    assert.equal((db.prepare("SELECT messages FROM sessions WHERE chat_id = ?").get(chatId) as { messages: string }).messages, before);
  });
});

describe("voice notes", () => {
  it("are transcribed and reach Claude as text", async () => {
    claude.replies.push({ content: [text("Siap, besok jam 7 saya ingatkan.")], stop_reason: "end_turn" });
    const voice: Media = { kind: "audio", mimetype: "audio/ogg; codecs=opus", size: 5, download: async () => Buffer.from("voice") };
    await handleIncoming(dm(ADMIN, "", voice), outbox);
    assert.match(lastUserText(claude.requests[0].body), /\[Voice note, transcribed automatically \(may contain small mistakes\): "Tolong ingatkan beli oli besok jam 7"\]/);
  });

  it("say so when there's no speech", async () => {
    claude.replies.push({ content: [text("Saya tidak menangkap suaranya.")], stop_reason: "end_turn" });
    const silent: Media = { kind: "audio", mimetype: "audio/ogg", size: 5, download: async () => Buffer.from("...") };
    await handleIncoming(dm(ADMIN, "", silent), outbox);
    assert.match(lastUserText(claude.requests[0].body), /no recognisable speech/);
  });
});

describe("profile photo", () => {
  it("can be changed by the admin only, from an image in the chat", async () => {
    const photos: Buffer[] = [];
    const withPhoto: Outbox = { ...outbox, setProfilePicture: async (image) => void photos.push(image) };
    claude.replies.push({ content: [text("ok")], stop_reason: "end_turn" }, { content: [text("ok")], stop_reason: "end_turn" });
    await handleIncoming(dm(ADMIN, "hi"), outbox);
    await handleIncoming(dm(WIFE, "hi"), outbox);
    const names = (i: number) => (claude.requests[i].body.tools as any[]).map((t) => t.name);
    assert.ok(names(0).includes("set_profile_picture"));
    assert.equal(names(1).includes("set_profile_picture"), false);

    const adminChat = dm(ADMIN, "").chat;
    const id = saveImage(adminChat.chatId, "image/png", generated);
    assert.equal((await runTool("set_profile_picture", { image_id: id }, { chat: adminChat, outbox: withPhoto })).isError, false);
    assert.deepEqual(photos, [generated]);
    const wifeTry = await runTool("set_profile_picture", { image_id: id }, { chat: dm(WIFE, "").chat, outbox: withPhoto });
    assert.match(wifeTry.content, /Only the admin/);
    assert.equal(photos.length, 1);
  });
});
