import { createHmac, randomBytes } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { clip as cutText } from "./format.js";
import { decrypt, encrypt } from "./google.js";
import { expireSession } from "./session.js";
import { formatDateTime } from "./time.js";
import type { ChatContext, Outbox } from "./types.js";

// Each contact links their own Shopee shop from their private chat, and Friday reads that shop only: orders, income,
// products and returns. Nothing is ever written to Shopee. The shop is looked up from the sender's number, never from
// anything Claude passes. Tokens are encrypted with GOOGLE_TOKEN_KEY, the same key as Google's and Spotify's.
//
// This is Friday's own Shopee Open Platform app, separate from onehub's: shops that authorize it never reach onehub's
// webhooks or back office. Shopee rotates the refresh token on every refresh, so both tokens are kept in the database.

const LINK_MINUTES = 10;
const MAX_CHARS = 20_000;
const DAY_S = 86_400;
const WINDOW_DAYS = 15; // Shopee's longest time range per order list call
const MAX_DAYS = 90;
const MAX_ORDERS = 1_000;
const DETAILED_ORDERS = 200;

export const shopeeEnabled = Boolean(config.SHOPEE_PARTNER_ID && config.SHOPEE_PARTNER_KEY && config.PUBLIC_URL && /^[0-9a-f]{64}$/i.test(config.GOOGLE_TOKEN_KEY));
// The state rides in the path: Shopee appends its own query to the redirect.
const redirectUri = (state: string) => `${config.PUBLIC_URL}/oauth/shopee/callback/${state}`;

/** Shopee never reaches groups: other people read every reply there. */
export function shopeeAllowed(chat: ChatContext): boolean {
  return shopeeEnabled && !chat.isGroup && chat.sender.isContact;
}

export type ShopeeShop = { shop_id: string; name: string };

export function shopeeShops(number: string): ShopeeShop[] {
  return db.prepare("SELECT shop_id, name FROM shopee_shops WHERE number = ? ORDER BY connected_at").all(number) as ShopeeShop[];
}

// --- Signing -------------------------------------------------------------------------------------------------------

const sign = (path: string, timestamp: number, token = "", shopId = "") =>
  createHmac("sha256", config.SHOPEE_PARTNER_KEY).update(`${config.SHOPEE_PARTNER_ID}${path}${timestamp}${token}${shopId}`).digest("hex");

const now = () => Math.floor(Date.now() / 1000);

function signedUrl(path: string, params: Record<string, string | number> = {}, shop?: { token: string; shopId: string }): string {
  const timestamp = now();
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    partner_id: config.SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    ...(shop && { access_token: shop.token, shop_id: shop.shopId }),
    sign: sign(path, timestamp, shop?.token, shop?.shopId),
  });
  return `${config.SHOPEE_API_URL}${path}?${query}`;
}

export class ShopeeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers }, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (body.error || !res.ok) throw new ShopeeError(body.error || `HTTP ${res.status}`, `Shopee said: ${body.message || body.error || `HTTP ${res.status}`}`);
  return body as T;
}

// --- Linking a shop ------------------------------------------------------------------------------------------------

/** Shopee's authorization page. Shopee has no state parameter, so the redirect address carries ours. */
export function connectLink(number: string, at = Date.now()): string {
  const state = randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM shopee_links WHERE number = ? OR created_at < ?").run(number, at - LINK_MINUTES * 60_000);
  db.prepare("INSERT INTO shopee_links (state, number, created_at) VALUES (?, ?, ?)").run(state, number, at);
  return signedUrl("/api/v2/shop/auth_partner", { redirect: redirectUri(state) });
}

/** Shopee's page for ending the access from their side. */
export const cancelLink = () => signedUrl("/api/v2/shop/cancel_auth_partner", { redirect: `${config.PUBLIC_URL}/oauth/shopee/putus` });

export function connectMessage(number: string, adminName: string): string {
  return [
    "🛍️ *Hubungkan toko Shopee*",
    `Kalau kamu setuju, ${config.BOT_NAME} bisa membaca pesanan, pendapatan, produk dan stok, serta retur di toko Shopee-mu. Hanya saat kamu memintanya di chat pribadi ini. ${config.BOT_NAME} tidak bisa mengubah apa pun di tokomu.`,
    [
      "*Sebelum setuju, perlu kamu tahu:*",
      `- Yang dibaca ${config.BOT_NAME} dikirim ke Claude (Anthropic) untuk diproses, dan tersimpan sementara di riwayat chat, di server yang dikelola ${adminName}.`,
      "- Login dengan akun toko, bukan akun induk (main account).",
      "- Putus kapan saja dengan /shopee putus.",
    ].join("\n"),
    `Link ini berlaku ${LINK_MINUTES} menit dan hanya untukmu:\n${connectLink(number)}`,
  ].join("\n\n");
}

type TokenResponse = { access_token: string; refresh_token: string; expire_in: number };

function saveTokens(number: string, shopId: string, token: TokenResponse) {
  db.prepare("UPDATE shopee_shops SET access_token = ?, access_expires = ?, refresh_token = ? WHERE number = ? AND shop_id = ?").run(
    encrypt(token.access_token),
    now() + token.expire_in,
    encrypt(token.refresh_token),
    number,
    shopId,
  );
}

/** Shopee's redirect back. Tells the person on WhatsApp how it went, and returns the page for their browser. */
export async function finishConnect(
  state: string,
  query: { code?: string; shop_id?: string; main_account_id?: string },
  outbox: Outbox,
  at = Date.now(),
): Promise<{ ok: boolean; title: string; text: string }> {
  const link = db.prepare("DELETE FROM shopee_links WHERE state = ? RETURNING number, created_at").get(state) as { number: string; created_at: number } | undefined;
  if (!link || at - link.created_at > LINK_MINUTES * 60_000) {
    return { ok: false, title: "Link sudah tidak berlaku", text: `Kirim /shopee ke ${config.BOT_NAME} untuk mendapatkan link baru.` };
  }
  const chatId = outbox.chatIdFor(link.number);
  if (!query.code || !query.shop_id) {
    const text = query.main_account_id
      ? "Yang dihubungkan tadi akun induk (main account). Kirim /shopee lagi, lalu login dengan akun toko yang mau dihubungkan."
      : "Toko Shopee tidak jadi dihubungkan. Kirim /shopee kalau berubah pikiran.";
    await outbox.sendText(chatId, text);
    return { ok: false, title: "Tidak jadi dihubungkan", text };
  }
  const shopId = query.shop_id.replace(/\D/g, "");
  try {
    const path = "/api/v2/auth/token/get";
    const token = await send<TokenResponse>(signedUrl(path), {
      method: "POST",
      body: JSON.stringify({ code: query.code, shop_id: Number(shopId), partner_id: Number(config.SHOPEE_PARTNER_ID) }),
    });
    const info = await send<{ shop_name?: string }>(signedUrl("/api/v2/shop/get_shop_info", {}, { token: token.access_token, shopId })).catch(() => ({ shop_name: undefined }));
    const name = info.shop_name || `Toko ${shopId}`;
    db.prepare(
      "INSERT OR REPLACE INTO shopee_shops (number, shop_id, name, access_token, access_expires, refresh_token, connected_at) VALUES (?, ?, ?, '', 0, '', ?)",
    ).run(link.number, shopId, name, at);
    saveTokens(link.number, shopId, token);
    expireSession(chatId); // tools and the system prompt are fixed for a session
    await outbox.sendText(chatId, `✅ Toko Shopee terhubung: ${name}\nCoba tulis: "Ada berapa pesanan yang belum dikirim hari ini?"`);
    return { ok: true, title: "Toko Shopee terhubung", text: `Kamu bisa kembali ke WhatsApp dan melanjutkan chat dengan ${config.BOT_NAME}.` };
  } catch (err) {
    console.error("Shopee link failed:", err instanceof Error ? err.message : "unknown error");
    await outbox.sendText(chatId, "Toko Shopee gagal dihubungkan. Coba lagi dengan /shopee.").catch(() => {});
    return { ok: false, title: "Gagal menghubungkan", text: "Coba lagi dengan mengirim /shopee di WhatsApp." };
  }
}

/** Forgets every shop this person linked, and clears the chat history that may hold their shop's data. */
export function disconnectShopee(number: string, chatId: string): boolean {
  const gone = db.prepare("DELETE FROM shopee_shops WHERE number = ?").run(number).changes > 0;
  if (gone) db.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  return gone;
}

// --- Calling Shopee ------------------------------------------------------------------------------------------------

// Shopee answers these when it's busy; anything else on a refresh means the access is gone.
const PASSING = /^(error_server|error_busy|error_inner|error_network|HTTP 5\d\d)/;
const refreshing = new Map<string, Promise<string>>();

async function accessToken(number: string, shopId: string): Promise<string> {
  const row = db.prepare("SELECT access_token, access_expires, refresh_token FROM shopee_shops WHERE number = ? AND shop_id = ?").get(number, shopId) as
    | { access_token: string; access_expires: number; refresh_token: string }
    | undefined;
  if (!row) throw new Error("This shop isn't connected anymore. Ask them to send /shopee.");
  if (row.access_expires > now() + 300) return decrypt(row.access_token);
  // The old refresh token stops working once used, so two refreshes at once would end the access.
  const key = `${number}:${shopId}`;
  const running = refreshing.get(key);
  if (running) return running;
  const refresh = (async () => {
    try {
      const token = await send<TokenResponse>(signedUrl("/api/v2/auth/access_token/get"), {
        method: "POST",
        body: JSON.stringify({ refresh_token: decrypt(row.refresh_token), shop_id: Number(shopId), partner_id: Number(config.SHOPEE_PARTNER_ID) }),
      });
      saveTokens(number, shopId, token);
      return token.access_token;
    } catch (err) {
      if (err instanceof ShopeeError && !PASSING.test(err.code)) {
        db.prepare("DELETE FROM shopee_shops WHERE number = ? AND shop_id = ?").run(number, shopId);
        throw new Error("Shopee ended this access (it was cancelled or expired). Ask them to send /shopee to connect again.");
      }
      throw err;
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, refresh);
  return refresh;
}

async function shopee<T = any>(number: string, shopId: string, path: string, params: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
  const query = Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined));
  const url = signedUrl(path, query, { token: await accessToken(number, shopId), shopId });
  const result = await send<{ response?: T }>(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return (result.response ?? {}) as T;
}

// --- Tools ---------------------------------------------------------------------------------------------------------

type Context = { chat: ChatContext; outbox: Outbox };

const clip = (text: string) => (text.length > MAX_CHARS ? `${cutText(text, MAX_CHARS)}\n[…cut, ${text.length} characters in all]` : text);
const when = (seconds?: number) => (seconds ? formatDateTime(new Date(seconds * 1000)) : "-");
const rupiah = (n?: number) => (typeof n === "number" ? `Rp${Math.round(n).toLocaleString("id-ID")}` : "-");
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const shopParam = z.string().optional().describe("Which shop, by name, when this person has more than one.");

/** Midnight at the start of `from` to the end of `to`, in Friday's timezone, as Unix seconds. */
export function dayRange(from: string, to: string): [number, number] {
  const offset = (date: string) => {
    const probe = new Date(`${date}T12:00:00Z`);
    const local = new Date(probe.toLocaleString("en-US", { timeZone: config.TIMEZONE }));
    const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    return (local.getTime() - utc.getTime()) / 1000;
  };
  const start = Date.parse(`${from}T00:00:00Z`) / 1000 - offset(from);
  const end = Date.parse(`${to}T00:00:00Z`) / 1000 - offset(to) + DAY_S - 1;
  if (!(end > start)) throw new Error("`to` must be on or after `from`.");
  if (end - start > MAX_DAYS * DAY_S) throw new Error(`Ask for at most ${MAX_DAYS} days at a time.`);
  return [start, Math.min(end, now())];
}

function windows([start, end]: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let from = start; from <= end; from += WINDOW_DAYS * DAY_S) out.push([from, Math.min(from + WINDOW_DAYS * DAY_S - 1, end)]);
  return out;
}

function pickShop(chat: ChatContext, wanted?: string): ShopeeShop {
  const shops = shopeeShops(chat.sender.number);
  if (!shops.length) throw new Error("No Shopee shop is connected. Ask them to send /shopee.");
  if (!wanted) {
    if (shops.length === 1) return shops[0];
    throw new Error(`Which shop? This person has: ${shops.map((s) => s.name).join(", ")}.`);
  }
  const needle = wanted.toLowerCase();
  const shop = shops.find((s) => s.name.toLowerCase() === needle || s.shop_id === wanted) ?? shops.find((s) => s.name.toLowerCase().includes(needle));
  if (!shop) throw new Error(`No connected shop called "${wanted}". Connected: ${shops.map((s) => s.name).join(", ")}.`);
  return shop;
}

type OrderItem = { item_name: string; model_name?: string; model_quantity_purchased: number; model_discounted_price?: number };
type Order = { order_sn: string; order_status: string; create_time: number; update_time?: number; total_amount?: number; item_list?: OrderItem[]; shipping_carrier?: string; ship_by_date?: number; cancel_reason?: string; note?: string; pay_time?: number };

const STATUSES = ["UNPAID", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "CANCELLED", "TO_RETURN", "COMPLETED"] as const;
const DETAIL_FIELDS = "item_list,total_amount,order_status,shipping_carrier,note,ship_by_date,cancel_reason,pay_time";

async function orderDetails(number: string, shopId: string, sns: string[]): Promise<Order[]> {
  const out: Order[] = [];
  for (const batch of chunks(sns, 50)) {
    const { order_list } = await shopee<{ order_list?: Order[] }>(number, shopId, "/api/v2/order/get_order_detail", { order_sn_list: batch.join(","), response_optional_fields: DETAIL_FIELDS });
    out.push(...(order_list ?? []));
  }
  return out;
}

const describeOrder = (o: Order) =>
  `- ${o.order_sn} | ${o.order_status} | ${when(o.create_time)} | ${rupiah(o.total_amount)} | ${(o.item_list ?? []).map((i) => `${i.item_name}${i.model_name ? ` (${i.model_name})` : ""} ×${i.model_quantity_purchased}`).join("; ")}`;

type Item = {
  item_id: number;
  item_name: string;
  item_sku?: string;
  item_status?: string;
  has_model?: boolean;
  price_info?: { current_price?: number; original_price?: number }[];
  stock_info_v2?: { summary_info?: { total_available_stock?: number } };
};
type Model = { model_id: number; model_sku?: string; tier_index?: number[]; price_info?: { current_price?: number }[]; stock_info_v2?: { summary_info?: { total_available_stock?: number } } };

async function describeItems(number: string, shopId: string, ids: number[]): Promise<string[]> {
  const rows: string[] = [];
  for (const batch of chunks(ids, 50)) {
    const { item_list } = await shopee<{ item_list?: Item[] }>(number, shopId, "/api/v2/product/get_item_base_info", { item_id_list: batch.join(",") });
    for (const item of item_list ?? []) {
      const stock = item.stock_info_v2?.summary_info?.total_available_stock;
      rows.push(`- ${item.item_name}${item.item_sku ? ` [${item.item_sku}]` : ""} | id ${item.item_id} | ${item.item_status ?? ""}${item.has_model ? "" : ` | ${rupiah(item.price_info?.[0]?.current_price)} | stock ${stock ?? "-"}`}`);
      if (!item.has_model) continue;
      const { tier_variation, model } = await shopee<{ tier_variation?: { option_list?: { option: string }[] }[]; model?: Model[] }>(number, shopId, "/api/v2/product/get_model_list", { item_id: item.item_id });
      for (const m of model ?? []) {
        const name = (m.tier_index ?? []).map((t, i) => tier_variation?.[i]?.option_list?.[t]?.option ?? "?").join(" / ");
        rows.push(`    · ${name || m.model_id}${m.model_sku ? ` [${m.model_sku}]` : ""} | ${rupiah(m.price_info?.[0]?.current_price)} | stock ${m.stock_info_v2?.summary_info?.total_available_stock ?? "-"}`);
      }
    }
  }
  return rows;
}

type Tool<S extends z.ZodObject = z.ZodObject> = { name: string; description: string; schema: S; run: (input: z.infer<S>, ctx: Context) => Promise<string> };
const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

const TOOLS = [
  tool({
    name: "shopee_orders",
    description:
      "Orders in this person's Shopee shop over a date range (their timezone): a count per status, the total, and each order with its items. " +
      "By default by the day the order was made; by=update finds orders whose status changed in the range.",
    schema: z.object({
      from: day,
      to: day,
      status: z.enum(STATUSES).optional().describe("Only this status, e.g. READY_TO_SHIP for orders still to be shipped."),
      by: z.enum(["create", "update"]).optional(),
      shop: shopParam,
    }),
    async run({ from, to, status, by, shop }, { chat }) {
      const { shop_id, name } = pickShop(chat, shop);
      const number = chat.sender.number;
      const listed: { order_sn: string; order_status: string }[] = [];
      for (const [time_from, time_to] of windows(dayRange(from, to))) {
        let cursor = "";
        do {
          const page = await shopee<{ order_list?: { order_sn: string; order_status: string }[]; more?: boolean; next_cursor?: string }>(number, shop_id, "/api/v2/order/get_order_list", {
            time_range_field: by === "update" ? "update_time" : "create_time",
            time_from,
            time_to,
            page_size: 100,
            cursor,
            order_status: status,
            response_optional_fields: "order_status",
          });
          listed.push(...(page.order_list ?? []));
          cursor = page.more ? (page.next_cursor ?? "") : "";
        } while (cursor && listed.length < MAX_ORDERS);
        if (listed.length >= MAX_ORDERS) break;
      }
      if (!listed.length) return `${name}: no orders from ${from} to ${to}${status ? ` with status ${status}` : ""}.`;
      const counts = new Map<string, number>();
      for (const o of listed) counts.set(o.order_status, (counts.get(o.order_status) ?? 0) + 1);
      const details = await orderDetails(number, shop_id, listed.slice(0, DETAILED_ORDERS).map((o) => o.order_sn));
      const sold = details.filter((o) => !["CANCELLED", "IN_CANCEL", "UNPAID"].includes(o.order_status));
      const lines = [
        `${name}, ${from} to ${to}: ${listed.length}${listed.length >= MAX_ORDERS ? "+" : ""} orders.`,
        `By status: ${[...counts].map(([s, n]) => `${s} ${n}`).join(", ")}`,
        `Total of ${sold.length} orders not cancelled or unpaid${details.length < listed.length ? ` (among the first ${details.length})` : ""}: ${rupiah(sold.reduce((sum, o) => sum + (o.total_amount ?? 0), 0))}. This is what buyers paid, before Shopee's fees; shopee_income has what the shop receives.`,
        "",
        ...details.map(describeOrder),
      ];
      return clip(lines.join("\n"));
    },
  }),
  tool({
    name: "shopee_order",
    description: "One order in full: items, status, courier, the buyer's note, and the shop's income from it after Shopee's fees.",
    schema: z.object({ order_sn: z.string().regex(/^[0-9A-Z]{8,20}$/), shop: shopParam }),
    async run({ order_sn, shop }, { chat }) {
      const { shop_id } = pickShop(chat, shop);
      const number = chat.sender.number;
      const [order] = await orderDetails(number, shop_id, [order_sn]);
      if (!order) return `No order ${order_sn} in this shop.`;
      const escrow = await shopee<unknown>(number, shop_id, "/api/v2/payment/get_escrow_detail_batch", {}, { order_sn_list: [order_sn] }).catch((err: Error) => `(income not available: ${err.message})`);
      return clip(`${JSON.stringify(order)}\n\nIncome after fees (amounts in rupiah):\n${typeof escrow === "string" ? escrow : JSON.stringify(escrow)}`);
    },
  }),
  tool({
    name: "shopee_income",
    description: "Money Shopee released to this person's shop over a date range: per order and in total, plus what is still pending.",
    schema: z.object({ from: day, to: day, shop: shopParam }),
    async run({ from, to, shop }, { chat }) {
      const { shop_id, name } = pickShop(chat, shop);
      const number = chat.sender.number;
      const released: { order_sn: string; payout_amount: number; escrow_release_time: number }[] = [];
      for (const [release_time_from, release_time_to] of windows(dayRange(from, to))) {
        for (let page_no = 1; released.length < MAX_ORDERS; page_no++) {
          const page = await shopee<{ escrow_list?: typeof released; more?: boolean }>(number, shop_id, "/api/v2/payment/get_escrow_list", { release_time_from, release_time_to, page_no, page_size: 100 });
          released.push(...(page.escrow_list ?? []));
          if (!page.more) break;
        }
      }
      const overview = await shopee<unknown>(number, shop_id, "/api/v2/payment/get_income_overview").catch(() => undefined);
      const total = released.reduce((sum, e) => sum + (e.payout_amount ?? 0), 0);
      return clip(
        [
          `${name}: ${rupiah(total)} released for ${released.length} orders from ${from} to ${to}.`,
          ...(overview ? [`Income overview now (released and pending): ${JSON.stringify(overview)}`] : []),
          "",
          ...released.map((e) => `- ${e.order_sn} | ${rupiah(e.payout_amount)} | ${when(e.escrow_release_time)}`),
        ].join("\n"),
      );
    },
  }),
  tool({
    name: "shopee_products",
    description: "Products in this person's Shopee shop with price and stock, per variation too. Search by name, or page through all of them, 50 at a time.",
    schema: z.object({
      search: z.string().min(1).optional().describe("Words in the product name."),
      status: z.enum(["NORMAL", "UNLIST", "BANNED"]).optional().describe("Without a search: live (NORMAL, default), unlisted or banned products."),
      offset: z.number().int().min(0).optional(),
      shop: shopParam,
    }),
    async run({ search, status, offset, shop }, { chat }) {
      const { shop_id, name } = pickShop(chat, shop);
      const number = chat.sender.number;
      let ids: number[];
      let total: number | undefined;
      let next: string | number | undefined;
      if (search) {
        const page = await shopee<{ item_id_list?: number[]; total_count?: number; next_offset?: string }>(number, shop_id, "/api/v2/product/search_item", { item_name: search, page_size: 50, offset: offset ? String(offset) : undefined });
        [ids, total, next] = [page.item_id_list ?? [], page.total_count, page.next_offset];
      } else {
        const page = await shopee<{ item?: { item_id: number }[]; total_count?: number; has_next_page?: boolean; next_offset?: number }>(number, shop_id, "/api/v2/product/get_item_list", { offset: offset ?? 0, page_size: 50, item_status: status ?? "NORMAL" });
        [ids, total, next] = [(page.item ?? []).map((i) => i.item_id), page.total_count, page.has_next_page ? page.next_offset : undefined];
      }
      if (!ids.length) return `${name}: no products found.`;
      const rows = await describeItems(number, shop_id, ids);
      return clip(`${name}: ${total ?? ids.length} products${search ? ` matching "${search}"` : ""}.${next ? ` More with offset ${next}.` : ""}\n${rows.join("\n")}`);
    },
  }),
  tool({
    name: "shopee_returns",
    description: "Return and refund requests made in this person's Shopee shop over a date range.",
    schema: z.object({ from: day, to: day, shop: shopParam }),
    async run({ from, to, shop }, { chat }) {
      const { shop_id, name } = pickShop(chat, shop);
      const number = chat.sender.number;
      type Return = { return_sn: string; order_sn: string; status: string; reason?: string; text_reason?: string; refund_amount?: number; create_time?: number; item?: { name?: string; amount?: number }[] };
      const returns: Return[] = [];
      for (const [create_time_from, create_time_to] of windows(dayRange(from, to))) {
        for (let page_no = 1; returns.length < MAX_ORDERS; page_no++) {
          const page = await shopee<{ return?: Return[]; more?: boolean }>(number, shop_id, "/api/v2/returns/get_return_list", { page_no, page_size: 50, create_time_from, create_time_to });
          returns.push(...(page.return ?? []));
          if (!page.more) break;
        }
      }
      if (!returns.length) return `${name}: no return requests from ${from} to ${to}.`;
      const rows = returns.map(
        (r) =>
          `- ${r.return_sn} | order ${r.order_sn} | ${r.status} | ${when(r.create_time)} | ${rupiah(r.refund_amount)} | ${r.reason ?? ""}${r.text_reason ? `: ${r.text_reason}` : ""} | ${(r.item ?? []).map((i) => `${i.name} ×${i.amount}`).join("; ")}`,
      );
      return clip(`${name}: ${returns.length} return requests from ${from} to ${to}.\n${rows.join("\n")}`);
    },
  }),
];

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/** The tools for this chat: only in private, and only once this person connected their own shop. */
export function shopeeTools(chat: ChatContext): BetaToolUnion[] {
  if (!shopeeAllowed(chat) || !shopeeShops(chat.sender.number).length) return [];
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }));
}

/** Runs a shopee_* tool. Returns undefined if `name` isn't one. */
export async function runShopeeTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("shopee_")) return undefined;
  if (!shopeeAllowed(chat)) throw new Error("Shopee isn't available in this chat. It works in the person's private chat.");
  const t = TOOLS.find((candidate) => candidate.name === name);
  if (!t) throw new Error(`No Shopee tool called ${name}.`);
  return t.run(t.schema.parse(input), { chat, outbox });
}
