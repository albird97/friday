import { ADMIN, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { decrypt } from "../src/google.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { dayRange, shopeeShops, shopeeTools } from "../src/shopee.js";
import { runTool } from "../src/tools.js";
import type { ChatContext, Outbox } from "../src/types.js";
import { handleWeb } from "../src/web.js";

type Sent = { chatId: string; text: string };
type Call = { path: string; query: URLSearchParams; body: any };
let sent = [] as Sent[];
let calls = [] as Call[];
let refreshError = "";

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
const day = (date: string) => Date.parse(`${date}T05:00:00Z`) / 1000;

// Shopee itself, faked. It checks every signature, and each access token names the code or refresh behind it.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host !== "partner.shopeemobile.com") return realFetch(input, init);
  const q = url.searchParams;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path: url.pathname, query: q, body });
  const base = `${q.get("partner_id")}${url.pathname}${q.get("timestamp")}${q.get("access_token") ?? ""}${q.get("shop_id") ?? ""}`;
  if (q.get("sign") !== createHmac("sha256", "shopee-key").update(base).digest("hex")) return json({ error: "error_sign", message: "Wrong sign." }, 403);
  const token = q.get("access_token") ?? "";
  switch (url.pathname) {
    case "/api/v2/auth/token/get":
      return json({ error: "", access_token: `access-${body.code}`, refresh_token: `refresh-${body.code}`, expire_in: 14400 });
    case "/api/v2/auth/access_token/get":
      if (refreshError) return json({ error: refreshError, message: "Invalid refresh_token." }, 403);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ error: "", access_token: `access-after-${body.refresh_token}`, refresh_token: `next-${body.refresh_token}`, expire_in: 14400 });
    case "/api/v2/shop/get_shop_info":
      return json({ error: "", shop_name: `Toko ${token}` });
    case "/api/v2/order/get_order_list": {
      const from = Number(q.get("time_from"));
      const orders = [
        { order_sn: "2611010001AAAA", order_status: "READY_TO_SHIP", create_time: day("2026-10-01") },
        { order_sn: "2611010002BBBB", order_status: "COMPLETED", create_time: day("2026-10-02") },
        { order_sn: "2611010003CCCC", order_status: "CANCELLED", create_time: day("2026-10-18") },
      ].filter((o) => o.create_time >= from && o.create_time <= Number(q.get("time_to")));
      return json({ error: "", response: { order_list: orders.map(({ order_sn, order_status }) => ({ order_sn, order_status })), more: false } });
    }
    case "/api/v2/order/get_order_detail":
      return json({
        error: "",
        response: {
          order_list: q
            .get("order_sn_list")!
            .split(",")
            .map((sn, i) => ({
              order_sn: sn,
              order_status: ["READY_TO_SHIP", "COMPLETED", "CANCELLED"][i],
              create_time: day("2026-10-01"),
              total_amount: 100_000 * (i + 1),
              item_list: [{ item_name: `Barang of ${token}`, model_name: "Merah", model_quantity_purchased: 2 }],
            })),
        },
      });
    case "/api/v2/payment/get_escrow_list":
      return json({ error: "", response: { escrow_list: [{ order_sn: "2611010002BBBB", payout_amount: 180_000, escrow_release_time: day("2026-10-05") }], more: false } });
    case "/api/v2/payment/get_income_overview":
      return json({ error: "", response: { total_income: { pending_amount: 50_000, released_amount: 180_000 } } });
    default:
      return json({ error: "", response: {} });
  }
}) as typeof fetch;

const chatOf = (who: { name: string; number: string }): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const groupOf = (who: { name: string; number: string }): ChatContext => ({ chatId: "1203@g.us", isGroup: true, chatName: "Kongkow", sender: { ...who, isContact: true } });
const say = (chat: ChatContext, text: string): Promise<void> => handleIncoming({ chat, text, addressed: true } satisfies Incoming, outbox);
const tool = (chat: ChatContext, name: string, input: unknown) => runTool(name, input, { chat, outbox });

/** Sends /shopee, then comes back from Shopee the way its redirect would. */
async function connect(who: { name: string; number: string }, query: string) {
  await say(chatOf(who), "/shopee");
  const link = new URL(sent.at(-1)!.text.match(/https:\/\/partner\.shopeemobile\.com\S+/)![0]);
  const redirect = new URL(link.searchParams.get("redirect")!);
  return { link, redirect, page: await handleWeb("GET", `${redirect.pathname}?${query}`, outbox) };
}

beforeEach(() => {
  for (const table of ["shopee_shops", "shopee_links"]) db.prepare(`DELETE FROM ${table}`).run();
  sent = [] as Sent[];
  calls = [] as Call[];
  refreshError = "";
});

describe("linking a Shopee shop", () => {
  it("says what it reads before linking, signs the link, and stores the tokens encrypted", async () => {
    const { link, redirect, page } = await connect(WIFE, "code=sarah&shop_id=555");
    assert.match(sent[0].text, /dikirim ke Claude \(Anthropic\)/);
    assert.match(sent[0].text, /tidak bisa mengubah apa pun/);
    assert.equal(link.pathname, "/api/v2/shop/auth_partner");
    assert.match(redirect.href, /^https:\/\/friday\.test\/oauth\/shopee\/callback\/[\w-]{32}$/);
    assert.equal(page.status, 200); // the fake refuses a wrong signature, so linking proves them right
    assert.deepEqual(shopeeShops(WIFE.number), [{ shop_id: "555", name: "Toko access-sarah" }]);
    const row = db.prepare("SELECT access_token, refresh_token FROM shopee_shops WHERE number = ?").get(WIFE.number) as { access_token: string; refresh_token: string };
    assert.equal(decrypt(row.refresh_token), "refresh-sarah");
    assert.equal(decrypt(row.access_token), "access-sarah");
    assert.ok(sent.some((s) => /Toko Shopee terhubung/.test(s.text)));
    const again = await handleWeb("GET", `${redirect.pathname}?code=attacker&shop_id=666`, outbox);
    assert.equal(again.status, 400);
    assert.deepEqual(shopeeShops(WIFE.number).map((s) => s.shop_id), ["555"]);
  });

  it("asks for the shop account when Shopee hands back a main account", async () => {
    const { page } = await connect(WIFE, "code=sarah&main_account_id=9");
    assert.equal(page.status, 400);
    assert.deepEqual(shopeeShops(WIFE.number), []);
    assert.match(sent.at(-1)!.text, /akun induk/);
  });

  it("stays out of groups", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    assert.deepEqual(shopeeTools(groupOf(WIFE)), []);
    await say(groupOf(WIFE), "/shopee");
    assert.match(sent.at(-1)!.text, /chat pribadi/);
    assert.equal((await tool(groupOf(WIFE), "shopee_orders", { from: "2026-10-01", to: "2026-10-02" })).isError, true);
  });

  it("disconnecting forgets the shop and points to Shopee's own cancel page", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    await say(chatOf(WIFE), "/shopee putus");
    assert.deepEqual(shopeeShops(WIFE.number), []);
    assert.match(sent.at(-1)!.text, /cancel_auth_partner/);
    assert.deepEqual(shopeeTools(chatOf(WIFE)), []);
  });
});

describe("reading the shop", () => {
  it("reads only the sender's own shop, and the prompt names it", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    assert.ok(shopeeTools(chatOf(WIFE)).some((t) => "name" in t && t.name === "shopee_orders"));
    assert.deepEqual(shopeeTools(chatOf(ADMIN)), []);
    assert.match(buildSystemPrompt(chatOf(WIFE), [], ""), /# Shopee \(this person's own shop: Toko access-sarah\)/);
    assert.match(buildSystemPrompt(chatOf(ADMIN), [], ""), /send \/shopee/);
    const result = await tool(chatOf(WIFE), "shopee_orders", { from: "2026-10-01", to: "2026-10-20" });
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /3 orders/);
    assert.match(result.content, /READY_TO_SHIP 1, COMPLETED 1, CANCELLED 1/);
    assert.match(result.content, /Rp300\.000/); // the cancelled order doesn't count
    assert.match(result.content, /Barang of access-sarah \(Merah\) ×2/);
    // 20 days take two of Shopee's 15-day windows, and every call is signed as Sarah's shop.
    const lists = calls.filter((c) => c.path === "/api/v2/order/get_order_list");
    assert.equal(lists.length, 2);
    assert.ok(lists.every((c) => c.query.get("shop_id") === "555" && c.query.get("access_token") === "access-sarah"));
  });

  it("adds up the money released", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    const result = await tool(chatOf(WIFE), "shopee_income", { from: "2026-10-01", to: "2026-10-07" });
    assert.match(result.content, /Rp180\.000 released for 1 orders/);
    assert.match(result.content, /pending_amount/);
  });

  it("asks which shop when there are several", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    await say(chatOf(WIFE), "/shopee");
    assert.match(sent.at(-1)!.text, /Toko Shopee terhubung/);
    await say(chatOf(WIFE), "/shopee tambah");
    const redirect = new URL(new URL(sent.at(-1)!.text.match(/https:\/\/partner\.shopeemobile\.com\S+/)![0]).searchParams.get("redirect")!);
    await handleWeb("GET", `${redirect.pathname}?code=kedua&shop_id=777`, outbox);
    assert.equal(shopeeShops(WIFE.number).length, 2);
    const unsure = await tool(chatOf(WIFE), "shopee_orders", { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(unsure.isError, true);
    assert.match(unsure.content, /Which shop\?/);
    const picked = await tool(chatOf(WIFE), "shopee_orders", { from: "2026-10-01", to: "2026-10-02", shop: "kedua" });
    assert.match(picked.content, /Barang of access-kedua/);
  });

  it("keeps date ranges in the person's timezone, and short enough", () => {
    assert.deepEqual(dayRange("2026-10-01", "2026-10-01"), [Date.parse("2026-09-30T17:00:00Z") / 1000, Date.parse("2026-10-01T16:59:59Z") / 1000]);
    assert.throws(() => dayRange("2026-01-01", "2026-06-01"), /at most 90 days/);
    assert.throws(() => dayRange("2026-10-02", "2026-10-01"), /on or after/);
  });
});

describe("Shopee's tokens", () => {
  const expire = () => db.prepare("UPDATE shopee_shops SET access_expires = 0").run();

  it("refreshes once for calls running together, and keeps the new refresh token", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    expire();
    const results = await Promise.all([1, 2, 3].map(() => tool(chatOf(WIFE), "shopee_income", { from: "2026-10-01", to: "2026-10-02" })));
    assert.ok(results.every((r) => !r.isError));
    assert.equal(calls.filter((c) => c.path === "/api/v2/auth/access_token/get").length, 1);
    const row = db.prepare("SELECT refresh_token FROM shopee_shops WHERE number = ?").get(WIFE.number) as { refresh_token: string };
    assert.equal(decrypt(row.refresh_token), "next-refresh-sarah");
    assert.ok(calls.some((c) => c.query.get("access_token") === "access-after-refresh-sarah"));
  });

  it("forgets the shop when Shopee ends the access, but not when Shopee is busy", async () => {
    await connect(WIFE, "code=sarah&shop_id=555");
    expire();
    refreshError = "error_busy";
    assert.equal((await tool(chatOf(WIFE), "shopee_income", { from: "2026-10-01", to: "2026-10-02" })).isError, true);
    assert.equal(shopeeShops(WIFE.number).length, 1);
    refreshError = "error_auth";
    const gone = await tool(chatOf(WIFE), "shopee_income", { from: "2026-10-01", to: "2026-10-02" });
    assert.match(gone.content, /send \/shopee to connect again/);
    assert.deepEqual(shopeeShops(WIFE.number), []);
  });
});
