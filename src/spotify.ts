import { randomBytes } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config } from "./config.js";
import { allContacts, findContact } from "./contacts.js";
import { db } from "./db.js";
import { clip as cutText } from "./format.js";
import { decrypt, encrypt } from "./google.js";
import { expireSession } from "./session.js";
import type { ChatContext, Outbox } from "./types.js";

// Each contact links their own Spotify from their private chat, and Friday makes playlists in that account only. The
// account is looked up from the sender's number, never from anything Claude passes. Someone's taste reaches another
// person's chat only after they allowed exactly that person with /spotify bareng. Refresh tokens are encrypted with
// GOOGLE_TOKEN_KEY, the same key as Google's.
//
// Spotify gives new apps no recommendations, so Claude picks the songs from the person's taste and spotify_search turns
// each pick into a real track. A playlist only ever gets tracks search returned.

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const LINK_MINUTES = 10;
const MAX_CHARS = 20_000;
const SCOPES = ["user-top-read", "user-library-read", "user-read-recently-played", "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public"];
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

export const spotifyEnabled = Boolean(config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET && config.PUBLIC_URL && /^[0-9a-f]{64}$/i.test(config.GOOGLE_TOKEN_KEY));
const redirectUri = () => `${config.PUBLIC_URL}/oauth/spotify/callback`;

/** Spotify never reaches groups: other people read every reply there. */
export function spotifyAllowed(chat: ChatContext): boolean {
  return spotifyEnabled && !chat.isGroup && chat.sender.isContact;
}

export type SpotifyAccount = { number: string; name: string };

export function spotifyAccount(number: string): SpotifyAccount | undefined {
  return db.prepare("SELECT number, name FROM spotify_accounts WHERE number = ?").get(number) as SpotifyAccount | undefined;
}

// --- Linking an account --------------------------------------------------------------------------------------------

export function connectLink(number: string, now = Date.now()): string {
  const state = randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM spotify_links WHERE number = ? OR created_at < ?").run(number, now - LINK_MINUTES * 60_000);
  db.prepare("INSERT INTO spotify_links (state, number, created_at) VALUES (?, ?, ?)").run(state, number, now);
  const params = new URLSearchParams({ client_id: config.SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(), scope: SCOPES.join(" "), state, show_dialog: "true" });
  return `${AUTH_URL}?${params}`;
}

export function connectMessage(number: string, adminName: string): string {
  return [
    "🎧 *Hubungkan Spotify*",
    `Kalau kamu setuju, ${config.BOT_NAME} bisa melihat lagu dan artis favoritmu, lagu yang kamu like, dan yang baru kamu putar, lalu membuat playlist di akun Spotify-mu. Hanya saat kamu memintanya di chat pribadi ini.`,
    [
      "*Sebelum setuju, perlu kamu tahu:*",
      `- Yang dibaca ${config.BOT_NAME} dikirim ke Claude (Anthropic) untuk diproses, dan tersimpan sementara di riwayat chat, di server yang dikelola ${adminName}.`,
      "- Playlist yang dibuat bersifat pribadi, tidak tampil di profilmu.",
      "- Seleramu tidak dipakai untuk orang lain, kecuali kamu mengizinkan orang itu dengan /spotify bareng <nama>.",
      "- Putus kapan saja dengan /spotify putus.",
    ].join("\n"),
    `Spotify membatasi app ini untuk 5 orang. Kalau setelah login muncul error, kirim email akun Spotify-mu ke ${adminName} supaya didaftarkan dulu.`,
    `Link ini berlaku ${LINK_MINUTES} menit dan hanya untukmu:\n${connectLink(number)}`,
  ].join("\n\n");
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!res.ok) throw new SpotifyAuthError(body.error ?? `HTTP ${res.status}`);
  return body;
}

class SpotifyAuthError extends Error {}

/** Spotify's redirect back. Tells the person on WhatsApp how it went, and returns the page for their browser. */
export async function finishConnect(state: string, code: string | undefined, outbox: Outbox, now = Date.now()): Promise<{ ok: boolean; title: string; text: string }> {
  const link = db.prepare("DELETE FROM spotify_links WHERE state = ? RETURNING number, created_at").get(state) as { number: string; created_at: number } | undefined;
  if (!link || now - link.created_at > LINK_MINUTES * 60_000) {
    return { ok: false, title: "Link sudah tidak berlaku", text: `Kirim /spotify ke ${config.BOT_NAME} untuk mendapatkan link baru.` };
  }
  const chatId = outbox.chatIdFor(link.number);
  if (!code) {
    await outbox.sendText(chatId, "Spotify tidak jadi dihubungkan. Kirim /spotify kalau berubah pikiran.");
    return { ok: false, title: "Tidak jadi dihubungkan", text: "Tidak ada akses yang diberikan. Kamu bisa menutup halaman ini." };
  }
  try {
    const token = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
    if (!token.refresh_token) throw new SpotifyAuthError("no refresh token");
    const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 403) {
      // Development-mode apps only work for the accounts listed in Spotify's dashboard.
      const admin = allContacts()[0];
      const who = allContacts().find((c) => c.number === link.number)?.name ?? `+${link.number}`;
      await outbox.sendText(chatId, `Akun Spotify-mu belum didaftarkan di ${config.BOT_NAME}. Kirim email akun Spotify-mu ke ${admin?.name ?? "admin"}, lalu coba /spotify lagi setelah didaftarkan.`);
      if (admin && admin.number !== link.number) {
        await outbox.sendText(outbox.chatIdFor(admin.number), `🎧 ${who} mencoba menghubungkan Spotify, tapi akunnya belum terdaftar. Tambahkan email Spotify-nya di developer.spotify.com/dashboard → app ${config.BOT_NAME} → User Management (maks. 5 orang).`);
      }
      return { ok: false, title: "Akun belum terdaftar", text: `Akun Spotify ini belum didaftarkan di ${config.BOT_NAME}. Detailnya sudah dikirim ke WhatsApp.` };
    }
    if (!res.ok) throw new SpotifyAuthError(`profile HTTP ${res.status}`);
    const me = (await res.json()) as { id: string; display_name?: string | null };
    const name = me.display_name || me.id;
    db.prepare("INSERT OR REPLACE INTO spotify_accounts (number, spotify_id, name, refresh_token, connected_at) VALUES (?, ?, ?, ?, ?)").run(link.number, me.id, name, encrypt(token.refresh_token), now);
    tokens.delete(link.number);
    expireSession(chatId); // tools and the system prompt are fixed for a session
    await outbox.sendText(chatId, `✅ Spotify terhubung: ${name}\nCoba tulis: "Buatkan playlist 20 lagu buat nyetir malam dari lagu-lagu yang sering aku dengar"`);
    return { ok: true, title: "Spotify terhubung", text: `Kamu bisa kembali ke WhatsApp dan melanjutkan chat dengan ${config.BOT_NAME}.` };
  } catch (err) {
    console.error("Spotify link failed:", err instanceof Error ? err.message : "unknown error");
    await outbox.sendText(chatId, "Spotify gagal dihubungkan. Coba lagi dengan /spotify.").catch(() => {});
    return { ok: false, title: "Gagal menghubungkan", text: "Coba lagi dengan mengirim /spotify di WhatsApp." };
  }
}

/**
 * Forgets the account and every permission this person gave, and clears the chat history that may hold their
 * listening data. Spotify has no way to revoke a token from here; spotify.com/account/apps does that.
 */
export function disconnectSpotify(number: string, chatId: string): boolean {
  const gone = db.prepare("DELETE FROM spotify_accounts WHERE number = ?").run(number).changes > 0;
  tokens.delete(number);
  db.prepare("DELETE FROM spotify_shares WHERE owner = ?").run(number);
  if (gone) db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  return gone;
}

// --- Sharing taste for joint playlists -----------------------------------------------------------------------------

/** `owner` lets `partner` use owner's taste. Returns the message for the owner, and tells the partner. */
export async function share(owner: ChatContext["sender"], who: string, outbox: Outbox): Promise<string> {
  const partner = findContact(who);
  if (!partner) return `Tidak ada kontak bernama "${who}". Tulis namanya seperti yang terdaftar di ${config.BOT_NAME}.`;
  if (partner.number === owner.number) return "Itu kamu sendiri 🙂";
  if (!spotifyAccount(owner.number)) return "Hubungkan Spotify-mu dulu dengan /spotify.";
  db.prepare("INSERT OR IGNORE INTO spotify_shares (owner, partner, created_at) VALUES (?, ?, ?)").run(owner.number, partner.number, Date.now());
  await outbox
    .sendText(outbox.chatIdFor(partner.number), `🎧 ${owner.name} mengizinkan selera musiknya dipakai untuk playlist bareng denganmu.${spotifyAccount(partner.number) ? `\nCoba tulis: "Buatkan playlist bareng ${owner.name} buat road trip"` : "\nHubungkan Spotify-mu dulu dengan /spotify."}`)
    .catch(() => {});
  return `✅ ${partner.name} sekarang bisa membuat playlist bareng dari seleramu, dan bisa melihat lagu dan artis favoritmu. Cabut dengan /spotify stop ${partner.name}.`;
}

export function unshare(owner: string, who: string): string {
  const partner = findContact(who);
  const gone = partner && db.prepare("DELETE FROM spotify_shares WHERE owner = ? AND partner = ?").run(owner, partner.number).changes > 0;
  return gone ? `✅ ${partner.name} tidak bisa lagi memakai seleramu. Yang sudah dibaca sebelumnya masih ada di riwayat chatnya sampai obrolannya direset.` : `Kamu belum mengizinkan "${who}".`;
}

export function sharesOf(number: string): { given: string[]; received: string[] } {
  const name = (n: string) => allContacts().find((c) => c.number === n)?.name ?? `+${n}`;
  const given = db.prepare("SELECT partner FROM spotify_shares WHERE owner = ?").all(number) as { partner: string }[];
  const received = db.prepare("SELECT owner FROM spotify_shares WHERE partner = ?").all(number) as { owner: string }[];
  return { given: given.map((r) => name(r.partner)), received: received.map((r) => name(r.owner)) };
}

// --- Calling Spotify -----------------------------------------------------------------------------------------------

const tokens = new Map<string, { value: string; expires: number }>();

async function accessToken(number: string, now = Date.now()): Promise<string> {
  const cached = tokens.get(number);
  if (cached && cached.expires > now + 60_000) return cached.value;
  const row = db.prepare("SELECT refresh_token FROM spotify_accounts WHERE number = ?").get(number) as { refresh_token: string } | undefined;
  if (!row) throw new Error("This person hasn't connected Spotify. Ask them to send /spotify.");
  try {
    const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token) });
    // Spotify sometimes hands out a new refresh token, and the old one stops working.
    if (token.refresh_token) db.prepare("UPDATE spotify_accounts SET refresh_token = ? WHERE number = ?").run(encrypt(token.refresh_token), number);
    tokens.set(number, { value: token.access_token, expires: now + token.expires_in * 1000 });
    return token.access_token;
  } catch (err) {
    if (err instanceof SpotifyAuthError && err.message === "invalid_grant") {
      db.prepare("DELETE FROM spotify_accounts WHERE number = ?").run(number);
      throw new Error("Spotify ended this access (it was removed or expired). Ask them to send /spotify to connect again.");
    }
    throw err;
  }
}

async function spotify<T = any>(number: string, path: string, req: { method?: string; query?: Record<string, string | number | undefined>; json?: unknown } = {}): Promise<T> {
  const query = Object.entries(req.query ?? {}).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  const url = `${API}${path}${query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : ""}`;
  const res = await fetch(url, {
    method: req.method ?? "GET",
    headers: { Authorization: `Bearer ${await accessToken(number)}`, ...(req.json !== undefined && { "Content-Type": "application/json" }) },
    body: req.json === undefined ? undefined : JSON.stringify(req.json),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error("Spotify's limit for this app is used up for now. Try again in a little while.");
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Spotify said: ${error.error?.message ?? `HTTP ${res.status}`}`);
  }
  return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
}

// --- Tools ---------------------------------------------------------------------------------------------------------

type Track = { uri: string; name: string; artists: { name: string }[]; album?: { name: string; release_date?: string } };
type Artist = { name: string; genres?: string[] };
// Spotify is renaming `track` to `item` (and a playlist's `tracks` to `items`) across its API, so read either.
type Saved = { track?: Track; item?: Track };
const savedTrack = (s: Saved) => (s.item ?? s.track)!;
type Context = { chat: ChatContext; outbox: Outbox };

const clip = (text: string) => (text.length > MAX_CHARS ? `${cutText(text, MAX_CHARS)}\n[…cut, ${text.length} characters in all]` : text);
const describe = (t: Track) => `- ${t.name} — ${t.artists.map((a) => a.name).join(", ")}${t.album ? ` (${t.album.name}${t.album.release_date ? `, ${t.album.release_date.slice(0, 4)}` : ""})` : ""} | ${t.uri}`;
const list = (rows: string[], none: string) => (rows.length ? clip(rows.join("\n")) : none);
const timeRange = z.enum(["short_term", "medium_term", "long_term"]).optional().describe("short_term ≈ 4 weeks, medium_term ≈ 6 months (default), long_term ≈ a year.");
const trackUris = z.array(z.string().regex(TRACK_URI, "Use spotify:track:… URIs from spotify_search or the other spotify tools.")).min(1).max(200);

async function taste(number: string, range: string | undefined): Promise<string> {
  const [artists, tracks] = await Promise.all([
    spotify<{ items: Artist[] }>(number, "/me/top/artists", { query: { time_range: range, limit: 20 } }),
    spotify<{ items: Track[] }>(number, "/me/top/tracks", { query: { time_range: range, limit: 30 } }),
  ]);
  const artistRows = artists.items.map((a) => `- ${a.name}${a.genres?.length ? ` (${a.genres.slice(0, 3).join(", ")})` : ""}`);
  return `Top artists:\n${list(artistRows, "(none yet)")}\n\nTop tracks:\n${list(tracks.items.map(describe), "(none yet)")}`;
}

type Tool<S extends z.ZodObject = z.ZodObject> = { name: string; description: string; schema: S; run: (input: z.infer<S>, ctx: Context) => Promise<string> };
const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

const TOOLS = [
  tool({
    name: "spotify_my_taste",
    description: "This person's most played artists and tracks on Spotify.",
    schema: z.object({ time_range: timeRange }),
    run: ({ time_range }, { chat }) => taste(chat.sender.number, time_range),
  }),
  tool({
    name: "spotify_liked_songs",
    description: "Songs this person liked (saved) on Spotify, newest first, 50 per page.",
    schema: z.object({ offset: z.number().int().min(0).optional() }),
    async run({ offset }, { chat }) {
      const page = await spotify<{ total: number; items: ({ added_at: string } & Saved)[] }>(chat.sender.number, "/me/tracks", { query: { limit: 50, offset } });
      return `${page.total} liked songs in all.\n${list(page.items.map((i) => `${describe(savedTrack(i))} | liked ${i.added_at.slice(0, 10)}`), "(none)")}`;
    },
  }),
  tool({
    name: "spotify_recently_played",
    description: "The last 50 tracks this person played on Spotify.",
    schema: z.object({}),
    async run(_i, { chat }) {
      const { items } = await spotify<{ items: ({ played_at: string } & Saved)[] }>(chat.sender.number, "/me/player/recently-played", { query: { limit: 50 } });
      return list(items.map((i) => `${describe(savedTrack(i))} | ${i.played_at.slice(0, 16)}`), "Nothing played recently.");
    },
  }),
  tool({
    name: "spotify_partner_taste",
    description: "Another contact's top artists and tracks, for a joint playlist. Works only if that person allowed this one with /spotify bareng.",
    schema: z.object({ partner: z.string().min(1).describe("Their name as this person calls them."), time_range: timeRange }),
    async run({ partner, time_range }, { chat }) {
      const contact = findContact(partner);
      const allowed = contact && db.prepare("SELECT 1 FROM spotify_shares WHERE owner = ? AND partner = ?").get(contact.number, chat.sender.number);
      if (!contact || !allowed) throw new Error(`${partner} hasn't allowed this. They can send: /spotify bareng ${chat.sender.name}`);
      if (!spotifyAccount(contact.number)) throw new Error(`${contact.name} isn't connected to Spotify anymore.`);
      return `${contact.name}'s taste:\n${await taste(contact.number, time_range)}`;
    },
  }),
  tool({
    name: "spotify_search",
    description: "Find the exact Spotify tracks for songs you picked. Give each as title plus artist. Returns up to 3 matches each, with the URI to use.",
    schema: z.object({ songs: z.array(z.string().min(1)).min(1).max(40).describe('e.g. ["Fix You Coldplay", "Sial Mahalini"]') }),
    async run({ songs }, { chat }) {
      const results: string[] = [];
      for (let i = 0; i < songs.length; i += 5) {
        const batch = await Promise.all(
          songs.slice(i, i + 5).map(async (song) => {
            const { tracks } = await spotify<{ tracks: { items: Track[] } }>(chat.sender.number, "/search", { query: { q: song, type: "track", limit: 3 } });
            return `"${song}":\n${tracks.items.map(describe).join("\n") || "- (not found)"}`;
          }),
        );
        results.push(...batch);
      }
      return clip(results.join("\n\n"));
    },
  }),
  tool({
    name: "spotify_create_playlist",
    description: "Create a private playlist in this person's own Spotify with these tracks, in order. Only after they asked for it.",
    schema: z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(300).optional(),
      track_uris: trackUris,
      collaborative: z.boolean().optional().describe("Let others they share the link with add songs too, e.g. for a joint playlist."),
    }),
    async run({ name, description, track_uris, collaborative }, { chat }) {
      const number = chat.sender.number;
      const playlist = await spotify<{ id: string; external_urls: { spotify: string } }>(number, "/me/playlists", {
        method: "POST",
        json: { name, description: description?.replace(/[\r\n]+/g, " "), public: false, collaborative: collaborative ?? false },
      });
      for (let i = 0; i < track_uris.length; i += 100) await spotify(number, `/playlists/${playlist.id}/items`, { method: "POST", json: { uris: track_uris.slice(i, i + 100) } });
      return `Playlist "${name}" made with ${track_uris.length} tracks: ${playlist.external_urls.spotify}`;
    },
  }),
  tool({
    name: "spotify_my_playlists",
    description: "This person's Spotify playlists. Only the ones they own (with an id) can be added to.",
    schema: z.object({ offset: z.number().int().min(0).optional() }),
    async run({ offset }, { chat }) {
      const me = db.prepare("SELECT spotify_id FROM spotify_accounts WHERE number = ?").get(chat.sender.number) as { spotify_id: string } | undefined;
      const page = await spotify<{ total: number; items: { id: string; name: string; owner: { id: string }; items?: { total: number }; tracks?: { total: number } }[] }>(chat.sender.number, "/me/playlists", { query: { limit: 50, offset } });
      const rows = page.items.map((p) => `- ${p.name}${(p.items ?? p.tracks) ? ` (${(p.items ?? p.tracks)!.total} tracks)` : ""}${p.owner.id === me?.spotify_id ? ` | id ${p.id}` : " | followed"}`);
      return `${page.total} playlists in all.\n${list(rows, "(none)")}`;
    },
  }),
  tool({
    name: "spotify_add_to_playlist",
    description: "Add tracks to the end of a playlist this person owns (id from spotify_my_playlists).",
    schema: z.object({ playlist_id: z.string().regex(/^[A-Za-z0-9]{22}$/), track_uris: trackUris }),
    async run({ playlist_id, track_uris }, { chat }) {
      for (let i = 0; i < track_uris.length; i += 100) await spotify(chat.sender.number, `/playlists/${playlist_id}/items`, { method: "POST", json: { uris: track_uris.slice(i, i + 100) } });
      return `Added ${track_uris.length} tracks.`;
    },
  }),
];

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/** The tools for this chat: only in private, and only once this person connected their own Spotify. */
export function spotifyTools(chat: ChatContext): BetaToolUnion[] {
  if (!spotifyAllowed(chat) || !spotifyAccount(chat.sender.number)) return [];
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }));
}

/** Runs a spotify_* tool. Returns undefined if `name` isn't one. */
export async function runSpotifyTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("spotify_")) return undefined;
  if (!spotifyAllowed(chat)) throw new Error("Spotify isn't available in this chat. It works in the person's private chat.");
  const t = TOOLS.find((candidate) => candidate.name === name);
  if (!t) throw new Error(`No Spotify tool called ${name}.`);
  return t.run(t.schema.parse(input), { chat, outbox });
}
