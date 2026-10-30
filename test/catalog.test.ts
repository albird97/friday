import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { catalogItems, syncCatalog, type CatalogApi, type CatalogItem, type Product } from "../src/catalog.js";

describe("WhatsApp Business catalog", () => {
  it("ships items with unique ids, short names and their pictures", () => {
    const items = catalogItems();
    assert.ok(items.length >= 5);
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
    for (const item of items) {
      assert.ok(item.name.length <= 60 && item.description.length > 20, item.id);
      assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", "catalog", item.image)), item.image);
    }
  });

  it("adds missing items, updates changed ones and leaves the rest alone", async () => {
    const [first, second, third] = catalogItems();
    const products: Product[] = [
      { id: "p1", retailerId: first.id, name: first.name, description: first.description, status: "APPROVED" },
      { id: "p2", retailerId: second.id, name: "Old name", description: second.description, status: "APPROVED" },
    ];
    const calls: string[] = [];
    const api: CatalogApi = {
      async list() {
        return products;
      },
      async create(item: CatalogItem, image: Buffer) {
        assert.ok(image.length > 1000, "sends the picture");
        calls.push(`create ${item.id}`);
        if (item.id === third.id) throw new Error("rejected");
        return { id: `new-${item.id}`, retailerId: item.id };
      },
      async update(productId: string, item: CatalogItem) {
        calls.push(`update ${productId} ${item.id}`);
        return { id: productId, retailerId: item.id };
      },
    };
    const report = await syncCatalog(api);
    assert.ok(!calls.some((c) => c.includes(first.id)), "unchanged items aren't re-sent (that would trigger another review)");
    assert.ok(calls.includes(`update p2 ${second.id}`));
    assert.ok(calls.includes(`create ${third.id}`));
    assert.equal(calls.length, 2, "stops at the first failure");
    assert.match(report, /⏸️ \d+ item lain belum dicoba/);
    assert.match(report, new RegExp(`✅ ${first.name}: disetujui`));
    assert.match(report, new RegExp(`✏️ ${second.name}: diperbarui`));
    assert.match(report, new RegExp(`⚠️ ${third.name.replace(/[&]/g, "\\$&")}: gagal \\(rejected\\)`));
    assert.match(report, /ditinjau WhatsApp/);
  });
});
