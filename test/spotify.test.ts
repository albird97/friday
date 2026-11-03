import { ADMIN, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { decrypt } from "../src/google.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { spotifyAccount, spotifyTools } from "../src/spotify.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { handleWeb } from "../src/web.js";

type Sent = { chatId: string; text: string };
type Call = { url: string; method: string; auth: string | null; body: string };
let sent = [] as Sent[];
let calls = [] as Call[];
let registered = true;
const uri = (n: number) => `spotify:track:${String(n).padStart(22, "a")}`;

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
const track = (name: string, n: number) => ({ uri: uri(n), name, artists: [{ name: "Artis" }], album: { name: "Album", release_date: "2020-01-01" } });

// Spotify itself, faked. Every access token names the refresh token behind it, so a test can see whose account was used.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/spotify\.com/.test(url)) return realFetch(input, init);
  const body = init?.body === undefined ? "" : String(init.body);
  const auth = new Headers(init?.headers).get("Authorization");
  calls.push({ url, method: init?.method ?? "GET", auth, body });
  if (url.endsWith("/api/token")) {
    const params = new URLSearchParams(body);
    if (params.get("grant_type") === "authorization_code") return json({ access_token: `access-${params.get("code")}`, expires_in: 3600, refresh_token: `refresh-${params.get("code")}` });
    return json({ access_token: `access-of-${params.get("refresh_token")}`, expires_in: 3600 });
  }
  if (url.endsWith("/v1/me")) return registered ? json({ id: `id-${auth}`, display_name: auth?.replace("Bearer access-", "") }) : json({ error: { message: "user may not be registered" } }, 403);
  if (url.includes("/me/top/artists")) return json({ items: [{ name: `Top artist of ${auth}` }] });
  if (url.includes("/me/top/tracks")) return json({ items: [track(`Top track of ${auth}`, 1)] });
  if (url.includes("/search")) return json({ tracks: { items: [track(new URL(url).searchParams.get("q")!, 2)] } });
  if (url.endsWith("/me/playlists") && init?.method === "POST") return json({ id: "p".repeat(22), external_urls: { spotify: "https://open.spotify.com/playlist/xyz" } }, 201);
  if (url.includes("/items")) return json({ snapshot_id: "s" }, 201);
  return json({});
}) as typeof fetch;

const chatOf = (who: { name: string; number: string }): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const groupOf = (who: { name: string; number: string }): ChatContext => ({ chatId: "1203@g.us", isGroup: true, chatName: "Kongkow", sender: { ...who, isContact: true } });
const say = (chat: ChatContext, text: string): Promise<void> => handleIncoming({ chat, text, addressed: true } satisfies Incoming, outbox);
const tool = (chat: ChatContext, name: string, input: unknown) => runTool(name, input, { chat, outbox });

async function connect(who: { name: string; number: string }, code: string) {
  await say(chatOf(who), "/spotify");
  const link = new URL(sent.at(-1)!.text.match(/https:\/\/accounts\.spotify\.com\S+/)![0]);
  return { link, page: await handleWeb("GET", `/oauth/spotify/callback?state=${link.searchParams.get("state")}&code=${code}`, outbox) };
}

beforeEach(() => {
  for (const table of ["spotify_accounts", "spotify_links", "spotify_shares"]) db.prepare(`DELETE FROM ${table}`).run();
  sent = [] as Sent[];
  calls = [] as Call[];
  registered = true;
});

describe("linking Spotify", () => {
  it("says what it reads before linking, and stores the token encrypted", async () => {
    const { link, page } = await connect(WIFE, "sarah");
    assert.match(sent[0].text, /dikirim ke Claude \(Anthropic\)/);
    assert.match(sent[0].text, /5 orang/);
    assert.equal(link.searchParams.get("redirect_uri"), "https://friday.test/oauth/spotify/callback");
    assert.equal(page.status, 200);
    assert.equal(spotifyAccount(WIFE.number)?.name, "sarah");
    const row = db.prepare("SELECT refresh_token FROM spotify_accounts WHERE number = ?").get(WIFE.number) as { refresh_token: string };
    assert.equal(decrypt(row.refresh_token), "refresh-sarah");
    const again = await handleWeb("GET", `/oauth/spotify/callback?state=${link.searchParams.get("state")}&code=attacker`, outbox);
    assert.equal(again.status, 400);
    assert.equal(spotifyAccount(WIFE.number)?.name, "sarah");
  });

  it("tells the person and the admin when the account isn't on the app's list yet", async () => {
    registered = false;
    const { page } = await connect(WIFE, "sarah");
    assert.equal(page.status, 400);
    assert.equal(spotifyAccount(WIFE.number), undefined);
    assert.ok(sent.some((s) => s.chatId === chatOf(WIFE).chatId && /belum didaftarkan/.test(s.text)));
    assert.ok(sent.some((s) => s.chatId === chatOf(ADMIN).chatId && /User Management/.test(s.text)));
  });

  it("stays out of groups", async () => {
    await connect(WIFE, "sarah");
    assert.deepEqual(spotifyTools(groupOf(WIFE)), []);
    await say(groupOf(WIFE), "/spotify");
    assert.match(sent.at(-1)!.text, /chat pribadi/);
    assert.equal((await tool(groupOf(WIFE), "spotify_my_taste", {})).isError, true);
  });
});

describe("playlists", () => {
  it("reads only the sender's own taste, and the prompt says it's theirs", async () => {
    await connect(WIFE, "sarah");
    assert.ok(spotifyTools(chatOf(WIFE)).some((t) => "name" in t && t.name === "spotify_create_playlist"));
    assert.deepEqual(spotifyTools(chatOf(ADMIN)), []);
    const result = await tool(chatOf(WIFE), "spotify_my_taste", { time_range: "short_term" });
    assert.match(result.content, /access-of-refresh-sarah/);
    assert.match(buildSystemPrompt(chatOf(WIFE), [], ""), /# Spotify \(this person's own account, sarah\)/);
    assert.match(buildSystemPrompt(chatOf(ADMIN), [], ""), /send \/spotify/);
  });

  it("makes a private playlist from searched tracks, 100 at a time, and refuses made-up URIs", async () => {
    await connect(WIFE, "sarah");
    const search = await tool(chatOf(WIFE), "spotify_search", { songs: ["Fix You Coldplay"] });
    assert.match(search.content, /spotify:track:/);
    const uris = Array.from({ length: 150 }, (_, i) => uri(i));
    const made = await tool(chatOf(WIFE), "spotify_create_playlist", { name: "Nyetir malam", track_uris: uris });
    assert.equal(made.isError, false);
    assert.match(made.content, /open\.spotify\.com/);
    const create = calls.find((c) => c.url.endsWith("/me/playlists") && c.method === "POST")!;
    assert.equal(JSON.parse(create.body).public, false);
    assert.deepEqual(calls.filter((c) => c.url.includes("/items")).map((c) => JSON.parse(c.body).uris.length), [100, 50]);
    const bad = await tool(chatOf(WIFE), "spotify_create_playlist", { name: "x", track_uris: ["https://evil.example"] });
    assert.equal(bad.isError, true);
  });
});

describe("joint playlists", () => {
  it("need the other person's permission, which they can take back", async () => {
    await connect(WIFE, "sarah");
    await connect(ADMIN, "albert");
    const before = await tool(chatOf(ADMIN), "spotify_partner_taste", { partner: "Sarah" });
    assert.equal(before.isError, true);
    assert.match(before.content, /\/spotify bareng Albert/);

    await say(chatOf(WIFE), "/spotify bareng Albert");
    assert.match(sent.at(-1)!.text, /Albert sekarang bisa/);
    assert.ok(sent.some((s) => s.chatId === chatOf(ADMIN).chatId && /Sarah mengizinkan/.test(s.text)));
    const allowed = await tool(chatOf(ADMIN), "spotify_partner_taste", { partner: "sarah" });
    assert.match(allowed.content, /access-of-refresh-sarah/);
    // One way only: Sarah allowing Albert doesn't let Sarah read Albert's.
    assert.equal((await tool(chatOf(WIFE), "spotify_partner_taste", { partner: "Albert" })).isError, true);

    await say(chatOf(WIFE), "/spotify stop Albert");
    assert.equal((await tool(chatOf(ADMIN), "spotify_partner_taste", { partner: "Sarah" })).isError, true);
  });

  it("disconnecting forgets the account and every permission given", async () => {
    await connect(WIFE, "sarah");
    await say(chatOf(WIFE), "/spotify bareng Albert");
    await say(chatOf(WIFE), "/spotify putus");
    assert.equal(spotifyAccount(WIFE.number), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM spotify_shares").get() as { n: number }).n, 0);
    assert.deepEqual(spotifyTools(chatOf(WIFE)), []);
  });
});
