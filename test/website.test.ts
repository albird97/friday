import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { catalogItems } from "../src/catalog.js";

// The website lists Friday's features. These checks fail when a feature ships without a decision about the site, so
// the page can't quietly fall behind. How to fix a failure: CLAUDE.md, "Shipping a feature".

const ROOT = path.join(import.meta.dirname, "..");
const CONTENT = path.join(ROOT, "website", "src", "content");
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(CONTENT, file), "utf8"));

const demos = json("demos.json") as Record<string, { thread: { kind: string }[] }>;
const map = json("feature-map.json") as { tools: Record<string, string>; commands: Record<string, string> };
const site = json("site.json") as { botNumber: string; requestText: string };
const catalogIds = catalogItems().map((item) => item.id);

const sources = fs
  .readdirSync(path.join(ROOT, "src"))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => fs.readFileSync(path.join(ROOT, "src", file), "utf8"))
  .join("\n");
const names = (pattern: RegExp) => [...new Set([...sources.matchAll(pattern)].map((match) => match[1]))];

describe("website stays in step with Friday", () => {
  it("has a chat demo for every catalog feature, and none for features that are gone", () => {
    assert.deepEqual(Object.keys(demos).sort(), [...catalogIds].sort());
  });

  it("uses only bubble kinds the site knows how to draw", () => {
    const kinds = new Set(["text", "voice", "file", "image", "poll"]);
    for (const [id, demo] of Object.entries(demos)) {
      for (const bubble of demo.thread) assert.ok(kinds.has(bubble.kind), `${id}: ${bubble.kind}`);
    }
  });

  it("has every tool and command classified", () => {
    const allowed = new Set([...catalogIds, "internal", "pending"]);
    const unknown = [
      ...names(/\bname: "([a-z_]+)"/g).filter((tool) => !allowed.has(map.tools[tool])),
      ...names(/case "(\/[a-z]+)"/g).filter((command) => !allowed.has(map.commands[command])),
    ];
    assert.deepEqual(unknown, [], "New feature? Classify it in website/src/content/feature-map.json as a catalog id, internal or pending.");
  });

  it("opens WhatsApp with the sentence Friday recognises", () => {
    const access = fs.readFileSync(path.join(ROOT, "src", "access.ts"), "utf8").toLowerCase();
    assert.ok(access.includes(site.requestText.toLowerCase()));
  });

  it("keeps private things off the public page", () => {
    const copy = fs
      .readdirSync(CONTENT)
      .filter((file) => file !== "feature-map.json")
      .map((file) => fs.readFileSync(path.join(CONTENT, file), "utf8"))
      .join("\n");
    assert.doesNotMatch(copy, /onehub|end-to-end|\/var\/www/i);
    const numbers = [...copy.matchAll(/\b62\d{8,13}\b/g)].map((match) => match[0]);
    assert.deepEqual([...new Set(numbers)].filter((number) => number !== site.botNumber), []);
  });
});
