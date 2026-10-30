import fs from "node:fs";
import path from "node:path";

// Friday's WhatsApp Business catalog lists what it can do. The items live in catalog/items.json (plus their pictures);
// the admin's /katalog command adds missing items and updates changed ones, matched by their id. Every new or changed
// item goes through WhatsApp's review before people see it.

export type CatalogItem = { id: string; name: string; description: string; image: string };
export type Product = { id: string; retailerId?: string; name?: string; description?: string; status?: string };

/** What the WhatsApp layer offers for the catalog (WhatsApp Business accounts only). */
export type CatalogApi = {
  list(): Promise<Product[]>;
  create(item: CatalogItem, image: Buffer): Promise<Product>;
  update(productId: string, item: CatalogItem, image: Buffer): Promise<Product>;
};

const DIR = path.join(import.meta.dirname, "..", "catalog");

export function catalogItems(dir = DIR): CatalogItem[] {
  return JSON.parse(fs.readFileSync(path.join(dir, "items.json"), "utf8")) as CatalogItem[];
}

const STATUS: Record<string, string> = { APPROVED: "disetujui", PENDING: "sedang ditinjau", REJECTED: "ditolak" };

/** Brings the WhatsApp catalog in line with catalog/items.json and reports what happened, item by item. */
export async function syncCatalog(api: CatalogApi, dir = DIR): Promise<string> {
  const existing = await api.list();
  const lines: string[] = [];
  let changed = 0;
  const items = catalogItems(dir);
  for (const [i, item] of items.entries()) {
    const current = existing.find((p) => p.retailerId === item.id);
    const image = () => fs.readFileSync(path.join(dir, item.image));
    try {
      if (!current) {
        await api.create(item, image());
        lines.push(`➕ ${item.name}: ditambahkan`);
        changed++;
      } else if (current.name !== item.name || current.description !== item.description) {
        await api.update(current.id, item, image());
        lines.push(`✏️ ${item.name}: diperbarui`);
        changed++;
      } else {
        lines.push(`✅ ${item.name}: ${STATUS[current.status ?? ""] ?? current.status ?? "tidak berubah"}`);
      }
    } catch (err) {
      console.error(`catalog: ${item.id} failed`, err);
      lines.push(`⚠️ ${item.name}: gagal (${err instanceof Error ? err.message : String(err)})`);
      // One failure usually means WhatsApp refuses them all; each attempt can take a minute to time out.
      if (i < items.length - 1) lines.push(`⏸️ ${items.length - i - 1} item lain belum dicoba.`);
      break;
    }
  }
  const note = changed ? "\n\n_Item baru atau yang diubah ditinjau WhatsApp dulu (biasanya beberapa jam) sebelum terlihat._" : "";
  return `🛍️ *Katalog Friday*\n${lines.join("\n")}${note}`;
}
