import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// nginx's gzip_static serves these, so the server never compresses on the fly.
const TYPES = new Set([".html", ".css", ".js", ".svg", ".json", ".txt"]);

for (const entry of fs.readdirSync("dist", { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !TYPES.has(path.extname(entry.name))) continue;
  const file = path.join(entry.parentPath, entry.name);
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
}
