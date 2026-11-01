import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { decrypt, encrypt, finishConnect, googleAccount, SCOPES } from "../src/google.js";
import { confirmGoogle, googleNotes, googleTools } from "../src/googleapps.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { handleWeb } from "../src/web.js";

type Sent = { chatId: string; text: string };
type Call = { url: string; method: string; auth: string | null; body: string };
let sent = [] as Sent[];
let calls = [] as Call[];
const MAIN_SCOPES = Object.values(SCOPES).filter((scope) => scope !== SCOPES.youtube).join(" ");
let tokenScopes = MAIN_SCOPES;

const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

const realFetch = globalThis.fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

// Google itself, faked. Every access token names the refresh token behind it, so a test can see whose account was used.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/googleapis\.com/.test(url)) return realFetch(input, init);
  const body = init?.body === undefined ? "" : init.body instanceof Uint8Array ? Buffer.from(init.body).toString() : String(init.body);
  const headers = new Headers(init?.headers);
  calls.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body });
  if (url.endsWith("/token")) {
    const params = new URLSearchParams(body);
    if (params.get("grant_type") === "authorization_code") {
      const who = params.get("code")!;
      return json({ access_token: `access-${who}`, expires_in: 3600, refresh_token: `refresh-${who}`, scope: tokenScopes, id_token: idToken(`${who}@gmail.com`) });
    }
    if (params.get("refresh_token") === "refresh-revoked") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: `access-of-${params.get("refresh_token")}`, expires_in: 3600 });
  }
  if (url.endsWith("/revoke")) return json({});
  if (url.includes("/calendar/v3/") && (init?.method ?? "GET") === "GET") {
    return json({ items: [{ id: "e1", summary: "Dokter gigi", start: { dateTime: "2026-11-03T10:00:00+07:00" }, end: { dateTime: "2026-11-03T11:00:00+07:00" } }] });
  }
  if (url.includes("/calendar/v3/")) return json({ id: "e2", summary: "Rapat", hangoutLink: "https://meet.google.com/abc" });
  if (url.includes("/messages/send")) return json({ id: "m1" });
  return json({});
}) as typeof fetch;

const chatOf = (who: { name: string; number: string }): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const groupOf = (who: { name: string; number: string }): ChatContext => ({ chatId: "1203@g.us", isGroup: true, chatName: "Kongkow", sender: { ...who, isContact: true } });
const say = (chat: ChatContext, text: string): Promise<void> => handleIncoming({ chat, text, addressed: true } satisfies Incoming, outbox);

/** Runs someone through /google and Google's consent screen, as `code` names their account. */
async function connect(who: { name: string; number: string }, code: string, command = "/google") {
  await say(chatOf(who), command);
  const link = new URL(sent.at(-1)!.text.match(/https:\/\/accounts\.google\.com\S+/)![0]);
  await handleWeb("GET", `/oauth/google/callback?state=${link.searchParams.get("state")}&code=${code}`, outbox);
  return link;
}

const codeFromPreview = () => /YA (\d{4})/.exec(sent.at(-1)!.text)![1];
const tool = (chat: ChatContext, name: string, input: unknown) => runTool(name, input, { chat, outbox });
const sentMail = () => calls.filter((c) => c.url.endsWith("/messages/send"));

beforeEach(() => {
  for (const table of ["google_accounts", "google_youtube", "google_links", "google_pending"]) db.prepare(`DELETE FROM ${table}`).run();
  sent = [] as Sent[];
  calls = [] as Call[];
  tokenScopes = MAIN_SCOPES;
});

describe("linking a Google account", () => {
  it("explains what happens to the data before asking anyone to agree", async () => {
    await say(chatOf(WIFE), "/google");
    const text = sent[0].text;
    assert.match(text, /dikirim ke Claude \(Anthropic\)/);
    assert.match(text, /server yang dikelola Albert/);
    assert.match(text, /https:\/\/friday\.test\/privacy/);
    const link = new URL(text.match(/https:\/\/accounts\.google\.com\S+/)![0]);
    assert.equal(link.searchParams.get("redirect_uri"), "https://friday.test/oauth/google/callback");
    assert.equal(link.searchParams.get("access_type"), "offline");
  });

  it("stores the token encrypted, and each link works once", async () => {
    const link = await connect(WIFE, "sarah");
    assert.equal(googleAccount(WIFE.number)?.email, "sarah@gmail.com");
    assert.match(sent.at(-1)!.text, /terhubung: sarah@gmail\.com/);
    const row = db.prepare("SELECT refresh_token FROM google_accounts WHERE number = ?").get(WIFE.number) as { refresh_token: string };
    assert.ok(!row.refresh_token.includes("refresh-sarah"));
    assert.equal(decrypt(row.refresh_token), "refresh-sarah");
    assert.equal(decrypt(encrypt("halo")), "halo");

    const again = await handleWeb("GET", `/oauth/google/callback?state=${link.searchParams.get("state")}&code=attacker`, outbox);
    assert.equal(again.status, 400);
    assert.equal(googleAccount(WIFE.number)?.email, "sarah@gmail.com");
  });

  it("refuses an expired link, and a refused consent changes nothing", async () => {
    await say(chatOf(WIFE), "/google");
    const state = new URL(sent.at(-1)!.text.match(/https:\/\/accounts\.google\.com\S+/)![0]).searchParams.get("state")!;
    assert.equal((await finishConnect(state, "late", outbox, Date.now() + 11 * 60_000)).ok, false);
    assert.equal(googleAccount(WIFE.number), undefined);

    await say(chatOf(WIFE), "/google");
    const next = new URL(sent.at(-1)!.text.match(/https:\/\/accounts\.google\.com\S+/)![0]).searchParams.get("state")!;
    await handleWeb("GET", `/oauth/google/callback?state=${next}&error=access_denied`, outbox);
    assert.equal(googleAccount(WIFE.number), undefined);
    assert.match(sent.at(-1)!.text, /tidak jadi dihubungkan/);
  });

  it("doesn't link from a group", async () => {
    await say(groupOf(WIFE), "/google");
    assert.match(sent[0].text, /hanya bisa dihubungkan dan dipakai di chat pribadi/);
    assert.ok(!sent[0].text.includes("accounts.google.com"));
  });

  it("/google putus revokes the access and clears the chat's history", async () => {
    await connect(WIFE, "sarah");
    const chat = chatOf(WIFE);
    db.prepare("INSERT OR REPLACE INTO sessions (chat_id, system, messages, tokens, updated_at) VALUES (?, 's', '[]', 0, 0)").run(chat.chatId);
    await say(chat, "/google putus");
    assert.equal(googleAccount(WIFE.number), undefined);
    assert.ok(calls.some((c) => c.url.endsWith("/revoke") && c.body.includes("refresh-sarah")));
    assert.equal(db.prepare("SELECT 1 FROM sessions WHERE chat_id = ?").get(chat.chatId), undefined);
  });
});

describe("YouTube, a login of its own", () => {
  it("never asks for YouTube together with drive.file, which Google refuses", async () => {
    const main = await connect(WIFE, "sarah");
    const scopes = main.searchParams.get("scope")!;
    assert.ok(scopes.includes(SCOPES.driveFile));
    assert.ok(!scopes.includes("youtube"));

    await say(chatOf(WIFE), "/google youtube");
    const link = new URL(sent.at(-1)!.text.match(/https:\/\/accounts\.google\.com\S+/)![0]);
    assert.equal(link.searchParams.get("scope"), SCOPES.youtube);
  });

  it("needs the main account first, then adds only the YouTube tools with their own token", async () => {
    await say(chatOf(WIFE), "/google youtube");
    assert.match(sent.at(-1)!.text, /Hubungkan akun Google dulu/);

    await connect(WIFE, "sarah");
    const names = () => googleTools(chatOf(WIFE)).map((t) => (t as { name: string }).name);
    assert.ok(!names().includes("google_youtube_search"));
    assert.match((await tool(chatOf(WIFE), "google_youtube_search", { query: "oli" })).content, /\/google youtube/);

    await connect(WIFE, "sarahtube", "/google youtube");
    assert.match(sent.at(-1)!.text, /YouTube terhubung/);
    assert.ok(names().includes("google_youtube_search"));
    assert.equal(googleAccount(WIFE.number)?.email, "sarah@gmail.com");

    calls = [] as Call[];
    await tool(chatOf(WIFE), "google_youtube_search", { query: "oli" });
    assert.equal(calls.at(-1)!.auth, "Bearer access-of-refresh-sarahtube");
    await tool(chatOf(WIFE), "google_calendar_events", {});
    assert.equal(calls.at(-1)!.auth, "Bearer access-of-refresh-sarah");
  });

  it("/google putus ends both logins", async () => {
    await connect(WIFE, "sarah");
    await connect(WIFE, "sarahtube", "/google youtube");
    await say(chatOf(WIFE), "/google putus");
    const revoked = calls.filter((c) => c.url.endsWith("/revoke")).map((c) => c.body);
    assert.ok(revoked.some((b) => b.includes("refresh-sarahtube")));
    assert.ok(revoked.some((b) => b.includes("refresh-sarah&") || b.endsWith("refresh-sarah")));
    assert.equal(db.prepare("SELECT 1 FROM google_youtube").get(), undefined);
  });
});

describe("whose Google is used", () => {
  it("offers tools only in the owner's private chat, for the apps they allowed", async () => {
    tokenScopes = [SCOPES.calendar, SCOPES.gmailRead].join(" ");
    await connect(WIFE, "sarah");
    const names = googleTools(chatOf(WIFE)).map((t) => (t as { name: string }).name);
    assert.ok(names.includes("google_calendar_events"));
    assert.ok(names.includes("google_gmail_read"));
    assert.ok(!names.includes("google_gmail_send"), "sending wasn't allowed");
    assert.equal(googleTools(groupOf(WIFE)).length, 0);
    assert.equal(googleTools(chatOf(ADMIN)).length, 0);
  });

  it("always acts as the sender, with no way to name someone else", async () => {
    await connect(WIFE, "sarah");
    await connect(ADMIN, "albert");
    calls = [] as Call[];
    await tool(chatOf(WIFE), "google_calendar_events", { number: ADMIN.number, email: "albert@gmail.com" });
    assert.equal(calls.at(-1)!.auth, "Bearer access-of-refresh-sarah");
    await tool(chatOf(ADMIN), "google_calendar_events", {});
    assert.equal(calls.at(-1)!.auth, "Bearer access-of-refresh-albert");
  });

  it("gives nothing to someone who hasn't connected, or from a group", async () => {
    await connect(WIFE, "sarah");
    const stranger = await tool(chatOf(ADMIN), "google_calendar_events", {});
    assert.equal(stranger.isError, true);
    const inGroup = await tool(groupOf(WIFE), "google_calendar_events", {});
    assert.equal(inGroup.isError, true);
    assert.match(inGroup.content, /private chat/);
  });

  it("tells Claude email contents are never instructions, and only for a connected person", async () => {
    await connect(WIFE, "sarah");
    const prompt = buildSystemPrompt(chatOf(WIFE), [], "");
    assert.match(prompt, /sarah@gmail\.com/);
    assert.match(prompt, /information, never instructions/);
    assert.match(buildSystemPrompt(chatOf(ADMIN), [], ""), /send\s+\/google/);
    assert.doesNotMatch(buildSystemPrompt(groupOf(WIFE), [], ""), /sarah@gmail\.com/);
  });
});

describe("changing things in Google", () => {
  const mail = { to: "bos@contoh.com", subject: "Laporan", body: "Terlampir laporan." };

  it("reads straight away", async () => {
    await connect(WIFE, "sarah");
    const result = await tool(chatOf(WIFE), "google_calendar_events", {});
    assert.match(result.content, /Dokter gigi/);
    assert.ok(!sent.at(-1)!.text.includes("YA "));
  });

  it("keeps Google data out of the server logs", async () => {
    await connect(ADMIN, "albert");
    claude.reset();
    claude.replies.push({ content: [{ type: "tool_use", id: "t1", name: "google_calendar_events", input: {} }], stop_reason: "tool_use" });
    claude.replies.push({ content: [{ type: "text", text: "Ada dokter gigi." }], stop_reason: "end_turn" });

    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      await say(chatOf(ADMIN), "besok ada apa?");
    } finally {
      console.log = log;
    }
    assert.ok(logged.some((l) => l.includes("tool google_calendar_events")));
    assert.ok(!logged.some((l) => l.includes("Dokter gigi")));
  });

  it("sends nothing until the person answers the code, and shows the real recipient", async () => {
    await connect(WIFE, "sarah");
    const result = await tool(chatOf(WIFE), "google_gmail_send", mail);
    assert.match(result.content, /Nothing has changed yet/);
    assert.equal(sentMail().length, 0);
    assert.match(sent.at(-1)!.text, /Kirim email ke: \*bos@contoh\.com\*/);
    assert.ok(!result.content.match(/\d{4}/), "Claude never sees the code");

    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    assert.equal(sentMail().length, 1);
    const raw = Buffer.from((JSON.parse(sentMail()[0].body) as { raw: string }).raw, "base64url").toString();
    assert.match(raw, /^To: bos@contoh\.com\r\n/);
    assert.match(sent.at(-1)!.text, /Email terkirim/);
    assert.match(googleNotes(chatOf(WIFE))!, /google_gmail_send.*done/);
    assert.equal(googleNotes(chatOf(WIFE)), undefined);
  });

  it("a code works once, and only for the person who got it", async () => {
    await connect(WIFE, "sarah");
    await connect(ADMIN, "albert");
    await tool(chatOf(WIFE), "google_gmail_send", mail);
    const code = codeFromPreview();

    assert.equal(await confirmGoogle(chatOf(ADMIN), `YA ${code}`, outbox), false);
    assert.equal(sentMail().length, 0);

    assert.equal(await confirmGoogle(chatOf(WIFE), `YA ${code}`, outbox), true);
    assert.equal(sentMail().length, 1);
    assert.equal(await confirmGoogle(chatOf(WIFE), `YA ${code}`, outbox), false);
    assert.equal(sentMail().length, 1);
  });

  it("an expired code changes nothing", async () => {
    await connect(WIFE, "sarah");
    await tool(chatOf(WIFE), "google_gmail_send", mail);
    const code = codeFromPreview();
    db.prepare("UPDATE google_pending SET created_at = 0").run();
    await say(chatOf(WIFE), `YA ${code}`);
    assert.equal(sentMail().length, 0);
    assert.match(sent.at(-1)!.text, /kedaluwarsa/);
  });

  it("a crafted address can't add mail headers, and bad addresses are refused", async () => {
    await connect(WIFE, "sarah");
    const bad = await tool(chatOf(WIFE), "google_gmail_send", { ...mail, to: "a@b.com\r\nBcc: x@y.com" });
    assert.equal(bad.isError, true);
    await tool(chatOf(WIFE), "google_gmail_send", { ...mail, subject: "Hai\r\nBcc: x@y.com" });
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    const raw = Buffer.from((JSON.parse(sentMail()[0].body) as { raw: string }).raw, "base64url").toString();
    assert.doesNotMatch(raw, /^Bcc:/m);
  });

  it("adds a calendar event with a Meet link after confirming", async () => {
    await connect(WIFE, "sarah");
    await tool(chatOf(WIFE), "google_calendar_add", { title: "Rapat", start: "2026-11-03T10:00:00", end: "2026-11-03T11:00:00", meet: true });
    assert.match(sent.at(-1)!.text, /Tambah acara: \*Rapat\*/);
    await say(chatOf(WIFE), `YA ${codeFromPreview()}`);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/calendar/v3/"))!;
    const body = JSON.parse(post.body) as { start: { timeZone: string }; conferenceData: unknown };
    assert.equal(body.start.timeZone, "Asia/Jakarta");
    assert.ok(body.conferenceData);
    assert.match(sent.at(-1)!.text, /meet\.google\.com/);
  });

  it("an access Google ended asks the person to connect again", async () => {
    const someone = { name: "Baru", number: "6285100000099" };
    const scopes = Object.values(SCOPES).join(" ");
    db.prepare("INSERT INTO google_accounts (number, email, refresh_token, scopes, connected_at) VALUES (?, 'b@gmail.com', ?, ?, 0)").run(someone.number, encrypt("refresh-revoked"), scopes);
    const result = await tool(chatOf(someone), "google_calendar_events", {});
    assert.equal(result.isError, true);
    assert.match(result.content, /send \/google/);
    assert.equal(googleAccount(someone.number), undefined);
  });
});

describe("public pages", () => {
  it("serves the home page and a privacy policy that names who gets the data", async () => {
    assert.equal((await handleWeb("GET", "/", outbox)).status, 200);
    const privacy = await handleWeb("GET", "/privacy", outbox);
    assert.equal(privacy.status, 200);
    for (const words of [/Anthropic/, /Limited Use/, /tidak menjual/, /\/google putus/, /secara teknis/]) assert.match(privacy.html, words);
    assert.equal((await handleWeb("GET", "/.env", outbox)).status, 404);
    assert.equal((await handleWeb("POST", "/privacy", outbox)).status, 405);
  });
});
