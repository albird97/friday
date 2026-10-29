import "./onehub-env.js";
import { ADMIN, claude, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleIncoming, type Incoming } from "../src/bot.js";
import { db } from "../src/db.js";
import { checkQuery, formatRows } from "../src/onehub.js";
import { runTool } from "../src/tools.js";
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

// Fake onehub API: one action, adjust_stock.
type Call = { path: string; auth: string | null; body: any };
const onehubCalls: Call[] = [];
let executeFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const href = String(url);
  if (!href.startsWith("http://onehub.test/internal/friday")) return realFetch(url, init);
  const path = href.slice("http://onehub.test/internal/friday".length);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  onehubCalls.push({ path, auth: new Headers(init?.headers).get("authorization"), body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (path === "/actions") {
    return json(200, {
      actions: [
        {
          name: "adjust_stock",
          description: "Set a product's stock count after a recount.",
          input_schema: { type: "object", properties: { sku: { type: "string" }, new_qty: { type: "integer" } }, required: ["sku", "new_qty"] },
        },
      ],
    });
  }
  if (path === "/guide") return json(200, { guide: "Orders live in `orders`." });
  if (path === "/actions/adjust_stock/preview") {
    if (body.params.sku === "NOPE") return json(422, { error: "SKU NOPE tidak ditemukan." });
    return json(200, { summary: `Ubah stok ${body.params.sku}: 10 → ${body.params.new_qty}`, token: "state-abc" });
  }
  if (path === "/actions/adjust_stock/execute") {
    return executeFails ? json(409, { error: "Stok sudah berubah sejak preview." }) : json(200, { message: `Stok ${body.params.sku} sekarang ${body.params.new_qty}.` });
  }
  return json(404, { error: "not found" });
}) as typeof fetch;

const chatOf = (who: { name: string; number: string }) => `${who.number}@s.whatsapp.net`;
function dm(from: { name: string; number: string }, text: string): Incoming {
  return { chat: { chatId: chatOf(from), isGroup: false, chatName: from.name, sender: { ...from, isContact: true } }, text, addressed: true };
}
function inGroup(from: { name: string; number: string }, text: string): Incoming {
  return { chat: { chatId: "family@g.us", isGroup: true, chatName: "Family", sender: { ...from, isContact: true } }, text, addressed: true };
}
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolNames = (body: any) => (body.tools as any[]).map((t) => t.name);
const codeIn = (message: string | undefined) => /YA (\d{4})/.exec(message ?? "")?.[1];

beforeEach(() => {
  claude.reset();
  sent = [];
  onehubCalls.length = 0;
  executeFails = false;
});

describe("onehub access", () => {
  it("offers onehub tools and instructions to allowed people in private chats, after the shared cached tools", async () => {
    claude.replies.push({ content: [text("Hi!")], stop_reason: "end_turn" });
    await handleIncoming(dm(ADMIN, "hi"), outbox);
    const body = claude.requests[0].body;
    const names = toolNames(body);
    assert.deepEqual(names.slice(-3), ["onehub_schema", "onehub_query", "onehub_adjust_stock"]);
    assert.ok(names.indexOf("web_fetch") < names.indexOf("onehub_schema"));
    assert.match(JSON.stringify(body.system), /onehub/);
    assert.equal(onehubCalls[0].auth, "Bearer test-onehub-token");
  });

  it("gives nothing to people outside ONEHUB_USERS, or in groups", async () => {
    claude.replies.push({ content: [text("Hi Sarah")], stop_reason: "end_turn" }, { content: [text("Hi all")], stop_reason: "end_turn" });
    await handleIncoming(dm(WIFE, "hi"), outbox);
    await handleIncoming(inGroup(ADMIN, "Friday, hi"), outbox);
    for (const { body } of claude.requests) {
      assert.equal(toolNames(body).some((n: string) => n.startsWith("onehub_")), false);
      assert.doesNotMatch(JSON.stringify(body.system), /onehub/);
    }
  });

  it("refuses onehub tools called from a chat that isn't allowed", async () => {
    const chat = dm(WIFE, "").chat;
    const result = await runTool("onehub_adjust_stock", { sku: "A", new_qty: 1 }, { chat, outbox });
    assert.equal(result.isError, true);
    assert.match(result.content, /isn't available/);
    assert.equal(onehubCalls.some((c) => c.path.includes("preview")), false);
  });
});

describe("onehub actions", () => {
  it("previews, waits for the code, runs on YA <code>, and tells Claude afterwards", async () => {
    claude.replies.push(
      { content: [toolUse("tu_1", "onehub_adjust_stock", { sku: "ABC-12", new_qty: 7 })], stop_reason: "tool_use" },
      { content: [text("Sudah saya kirim preview-nya.")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "stok ABC-12 jadi 7 ya"), outbox);

    const confirmation = sent.find((s) => s.text?.includes("Konfirmasi onehub"));
    assert.match(confirmation?.text ?? "", /Ubah stok ABC-12: 10 → 7/);
    const code = codeIn(confirmation?.text);
    assert.ok(code);
    assert.equal(onehubCalls.some((c) => c.path.endsWith("/execute")), false);
    const toolResult = claude.requests[1].body.messages.at(-1).content[0];
    assert.match(toolResult.content, /Nothing has changed yet/);
    assert.doesNotMatch(toolResult.content, new RegExp(code!));

    sent = [];
    const requestsBefore = claude.requests.length;
    await handleIncoming(dm(ADMIN, `ya ${code}`), outbox);
    const execute = onehubCalls.find((c) => c.path === "/actions/adjust_stock/execute");
    assert.deepEqual(execute?.body, { params: { sku: "ABC-12", new_qty: 7 }, token: "state-abc", requested_by: { name: ADMIN.name, number: ADMIN.number } });
    assert.deepEqual(sent, [{ chatId: chatOf(ADMIN), text: "✅ Stok ABC-12 sekarang 7." }]);
    assert.equal(claude.requests.length, requestsBefore, "confirmations never reach Claude");

    // The same code can't run twice; with nothing else waiting, the message is an ordinary one.
    claude.replies.push({ content: [text("👍")], stop_reason: "end_turn" });
    await handleIncoming(dm(ADMIN, `YA ${code}`), outbox);
    assert.equal(onehubCalls.filter((c) => c.path.endsWith("/execute")).length, 1);
    const next = claude.requests.at(-1)!.body.messages.at(-1).content;
    assert.match(next[0].text, /System note.*adjust_stock.*done — Stok ABC-12 sekarang 7/s);
  });

  it("rejects wrong and expired codes, and reports onehub's refusals", async () => {
    claude.replies.push(
      { content: [toolUse("tu_2", "onehub_adjust_stock", { sku: "XYZ-1", new_qty: 3 })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "set XYZ-1 to 3"), outbox);
    const code = codeIn(sent.find((s) => s.text?.includes("Konfirmasi"))?.text)!;
    const wrong = code === "1000" ? "1001" : "1000";

    sent = [];
    await handleIncoming(dm(ADMIN, `YA ${wrong}`), outbox);
    assert.match(sent[0].text!, /tidak cocok/);

    executeFails = true;
    sent = [];
    await handleIncoming(dm(ADMIN, `YA ${code}`), outbox);
    assert.equal(sent[0].text, "❌ onehub tidak menjalankan aksi itu: Stok sudah berubah sejak preview.");

    claude.replies.push(
      { content: [toolUse("tu_3", "onehub_adjust_stock", { sku: "XYZ-1", new_qty: 4 })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    );
    sent = [];
    await handleIncoming(dm(ADMIN, "set XYZ-1 to 4"), outbox);
    const late = codeIn(sent.find((s) => s.text?.includes("Konfirmasi"))?.text)!;
    db.prepare("UPDATE pending_actions SET created_at = ? WHERE code = ? AND status = 'pending'").run(Date.now() - 11 * 60_000, late);
    sent = [];
    await handleIncoming(dm(ADMIN, `YA ${late}`), outbox);
    assert.match(sent[0].text!, /kedaluwarsa/);
  });

  it("passes onehub's validation errors back to Claude without asking for confirmation", async () => {
    claude.replies.push(
      { content: [toolUse("tu_4", "onehub_adjust_stock", { sku: "NOPE", new_qty: 1 })], stop_reason: "tool_use" },
      { content: [text("SKU itu tidak ada.")], stop_reason: "end_turn" },
    );
    await handleIncoming(dm(ADMIN, "set NOPE to 1"), outbox);
    const result = claude.requests[1].body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.equal(result.content, "SKU NOPE tidak ditemukan.");
    assert.equal(sent.some((s) => s.text?.includes("Konfirmasi")), false);
  });

  it("leaves 'yes 2026' alone for people without onehub", async () => {
    claude.replies.push({ content: [text("Great year!")], stop_reason: "end_turn" });
    await handleIncoming(dm(WIFE, "yes 2026"), outbox);
    assert.equal(claude.requests.length, 1);
  });
});

describe("onehub reading", () => {
  it("only accepts single SELECT statements", () => {
    assert.equal(checkQuery("  select 1;  "), "select 1");
    assert.equal(checkQuery("WITH t AS (SELECT 1) SELECT * FROM t"), "WITH t AS (SELECT 1) SELECT * FROM t");
    assert.throws(() => checkQuery("update products set stock = 0"), /Only SELECT/);
    assert.throws(() => checkQuery("select 1; delete from orders"), /one statement/);
    assert.throws(() => checkQuery("select set_config('statement_timeout', '0', false)"), /isn't allowed/);
    assert.throws(() => checkQuery("select pg_sleep(60)"), /isn't allowed/);
  });

  it("formats rows compactly and caps them", () => {
    assert.equal(formatRows(["a", "b"], []), "No rows.");
    assert.equal(formatRows(["sku", "qty"], [["A-1", 3], ["B 2\nx", null]]), "2 rows\nsku | qty\nA-1 | 3\nB 2 x | ");
    const many = formatRows(["n"], Array.from({ length: 250 }, (_, i) => [i]));
    assert.match(many, /^250 rows \(showing the first 200/);
    assert.equal(many.split("\n").length, 202);
  });

  it("runs read-only queries against a real database", { skip: !process.env.ONEHUB_TEST_DATABASE_URL && "set ONEHUB_TEST_DATABASE_URL" }, async () => {
    const chat = dm(ADMIN, "").chat;
    const ok = await runTool("onehub_query", { sql: "select 1 + 1 as two, now()::date = current_date as today" }, { chat, outbox });
    assert.equal(ok.content, "1 row\ntwo | today\n2 | true");
    const write = await runTool("onehub_query", { sql: "with x as (insert into t values (1) returning 1) select * from x" }, { chat, outbox });
    assert.equal(write.isError, true);
    const schema = await runTool("onehub_schema", {}, { chat, outbox });
    assert.match(schema.content, /^Orders live in `orders`\.\n\nReadable tables: /);
  });
});
