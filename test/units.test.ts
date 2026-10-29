import { ADMIN } from "./setup.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { addContact, allContacts, findContact, removeContact, takeDailyQuota } from "../src/contacts.js";
import { markdownToDocx } from "../src/docs/docx.js";
import { parseMarkdown } from "../src/docs/markdown.js";
import { markdownToPdf } from "../src/docs/pdf.js";
import { sheetsToXlsx, sheetToCsv } from "../src/docs/sheets.js";
import { slidesToPptx } from "../src/docs/slides.js";
import { chunk, toWhatsApp } from "../src/format.js";
import { outputSize } from "../src/images.js";
import { hideSignalSessionDumps } from "../src/logging.js";
import { addMemory, forgetMemory, memoriesFor, SHARED } from "../src/memory.js";
import { createReminder, fireDueReminders, listReminders, nextRun } from "../src/reminders.js";
import { isStale, recapOf } from "../src/session.js";
import { runTool, toolParams } from "../src/tools.js";
import type { Outbox } from "../src/types.js";

function fakeOutbox() {
  const sent: { chatId: string; text?: string; file?: string }[] = [];
  const outbox: Outbox = {
    async sendText(chatId, text) {
      sent.push({ chatId, text });
    },
    async sendFile(chatId, file) {
      sent.push({ chatId, file: file.fileName });
    },
    async sendImage(chatId) {
      sent.push({ chatId, file: "image" });
    },
    async typing() {},
    chatIdFor: (n) => `${n}@s.whatsapp.net`,
  };
  return { outbox, sent };
}

describe("WhatsApp formatting", () => {
  it("converts Markdown to WhatsApp style but leaves code alone", () => {
    assert.equal(toWhatsApp("# Title\n**bold** and [site](https://x.com)\n* item"), "*Title*\n*bold* and site (https://x.com)\n- item");
    assert.equal(toWhatsApp("```\n**keep**\n```"), "```\n**keep**\n```");
  });
  it("splits long text on paragraph breaks", () => {
    const parts = chunk(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    assert.deepEqual(parts.map((p) => p[0]), ["a", "b"]);
  });
});

describe("reminders", () => {
  it("reads one-off times in the configured timezone (Asia/Jakarta, UTC+7)", () => {
    assert.equal(nextRun("2030-01-01T09:00", new Date("2029-12-31T00:00:00Z"))?.toISOString(), "2030-01-01T02:00:00.000Z");
    assert.equal(nextRun("2020-01-01T09:00"), null);
  });
  it("fires due reminders once, and reschedules repeating ones", async () => {
    const { outbox, sent } = fakeOutbox();
    const once = createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "call mom", when: "2099-01-01T09:00" });
    const daily = createReminder({ chatId: "chat-a", createdBy: ADMIN.number, text: "vitamins", cron: "0 8 * * *" });
    await fireDueReminders(outbox, new Date(Math.max(once.due_at, daily.due_at) + 1000));
    assert.ok(sent.some((s) => s.text?.includes("call mom")));
    assert.ok(sent.some((s) => s.text?.includes("vitamins")));
    const left = listReminders(["chat-a"], "nobody");
    assert.deepEqual(left.map((r) => r.text), ["vitamins"]);
    assert.ok(left[0].due_at > daily.due_at);
  });
  it("rejects invalid schedules", () => {
    assert.throws(() => createReminder({ chatId: "c", createdBy: "x", text: "t", cron: "every day" }));
    assert.throws(() => createReminder({ chatId: "c", createdBy: "x", text: "t", when: "2001-01-01T00:00" }), /in the past/);
  });
});

describe("contacts and limits", () => {
  it("lets the admin add and remove people, but not .env contacts", () => {
    addContact("Mom", "+62 813-3333-3333");
    assert.equal(findContact("mom")?.number, "6281333333333");
    assert.ok(allContacts().some((c) => c.name === "Mom"));
    assert.match(removeContact("Albert").error ?? "", /\.env/);
    assert.equal(removeContact("Mom").removed?.name, "Mom");
  });
  it("enforces the daily message limit, except for the admin", () => {
    const results = [1, 2, 3, 4].map(() => takeDailyQuota("6289999999999", "2026-01-01"));
    assert.deepEqual(results, [true, true, true, false]);
    assert.ok([1, 2, 3, 4, 5].every(() => takeDailyQuota(ADMIN.number, "2026-01-01")));
  });
});

describe("memory", () => {
  it("scopes memories to their owner", () => {
    const mine = addMemory(ADMIN.number, "likes kopi susu");
    addMemory(SHARED, "family dinner is on Sundays");
    assert.deepEqual(memoriesFor([SHARED, ADMIN.number]).map((m) => m.fact), ["likes kopi susu", "family dinner is on Sundays"]);
    assert.equal(forgetMemory(mine, ["someone-else"]), false);
    assert.equal(forgetMemory(mine, [ADMIN.number]), true);
  });
});

describe("sessions", () => {
  it("goes stale after idle time or too many tokens", () => {
    const fresh = { system: "", messages: [], tokens: 10, updatedAt: Date.now() };
    assert.equal(isStale(fresh), false);
    assert.equal(isStale({ ...fresh, updatedAt: Date.now() - 7 * 3_600_000 }), true);
    assert.equal(isStale({ ...fresh, tokens: 1_000_000 }), true);
  });
  it("recaps only visible text", () => {
    const recap = recapOf([
      { role: "user", content: [{ type: "text", text: "[time] Albert: hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "s" }, { type: "text", text: "Hello!" }] },
    ]);
    assert.equal(recap, "[time] Albert: hi\nFriday: Hello!");
  });
});

describe("documents", () => {
  const md = "## Plan\n- **one**\n  - nested\n1. first\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n```\ncode → here\n```";
  it("parses Markdown into blocks", () => {
    assert.deepEqual(parseMarkdown(md).map((b) => b.type), ["heading", "list", "list", "table", "quote", "code"]);
  });
  it("renders every format", async () => {
    assert.equal((await markdownToPdf("T", md)).subarray(0, 4).toString(), "%PDF");
    assert.equal((await markdownToDocx("T", md)).subarray(0, 2).toString(), "PK");
    assert.equal((await sheetsToXlsx([{ name: "S", rows: [["a", "b"], [1, "=A2*2"]] }])).subarray(0, 2).toString(), "PK");
    assert.equal((await slidesToPptx("T", "sub", [{ title: "x", bullets: ["y"], table: [["h"], ["v"]] }])).subarray(0, 2).toString(), "PK");
    assert.equal(sheetToCsv({ name: "S", rows: [["a,b", 'say "hi"'], [1, null]] }).toString(), '"a,b","say ""hi"""\n1,\n');
  });
});

describe("tools", () => {
  it("publishes JSON schemas without $schema, plus web search/fetch", () => {
    const names = toolParams.map((t) => ("name" in t ? t.name : ""));
    for (const n of ["create_reminder", "create_document", "generate_image", "edit_image", "web_search", "web_fetch"]) assert.ok(names.includes(n), n);
    const doc = toolParams.find((t) => "name" in t && t.name === "create_document") as { input_schema: Record<string, unknown> };
    assert.equal(doc.input_schema.type, "object");
    assert.equal("$schema" in doc.input_schema, false);
  });
  it("validates input and blocks non-contacts from acting on others", async () => {
    const { outbox } = fakeOutbox();
    const stranger = { chat: { chatId: "g@g.us", isGroup: true, chatName: "g", sender: { number: "1", name: "X", isContact: false } }, outbox };
    assert.equal((await runTool("create_reminder", { text: 5 }, stranger)).isError, true);
    const r = await runTool("send_message", { to: "Sarah", text: "hi" }, stranger);
    assert.equal(r.isError, true);
    assert.match(r.content, /known contacts/);
  });
  it("sizes generated images to about a megapixel", () => {
    assert.deepEqual(outputSize("1:1"), { width: 1024, height: 1024 });
    assert.deepEqual(outputSize("16:9"), { width: 1360, height: 768 });
    assert.deepEqual(outputSize(undefined, { width: 3000, height: 4000 }), { width: 880, height: 1184 });
  });
});

describe("logging", () => {
  it("drops libsignal's session dumps (they contain keys) but keeps other output", () => {
    const seen: unknown[][] = [];
    const saved = { info: console.info, warn: console.warn };
    console.info = console.warn = (...args: unknown[]) => void seen.push(args);
    try {
      hideSignalSessionDumps();
      const { SessionRecord } = createRequire(import.meta.url)("libsignal");
      const record = new SessionRecord();
      const session = { indexInfo: { closed: -1 }, currentRatchet: { rootKey: Buffer.from("secret") } };
      record.closeSession(session);
      record.closeSession(session); // "Session already closed"
      record.openSession(session);
      console.warn("something else");
    } finally {
      Object.assign(console, saved);
    }
    assert.deepEqual(seen, [["something else"]]);
  });
});
