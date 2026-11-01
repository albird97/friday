import fs from "node:fs";
import path from "node:path";

// Fails the build when the page gets heavier than the plan allows. Sizes are gzip, as served.
const LIMITS = { ".js.gz": 75_000, ".css.gz": 20_000, ".woff2": 72_000, ".html.gz": 40_000 };
const totals = Object.fromEntries(Object.keys(LIMITS).map((suffix) => [suffix, 0]));

for (const entry of fs.readdirSync("dist", { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name === "404.html.gz") continue;
  const suffix = Object.keys(LIMITS).find((key) => entry.name.endsWith(key));
  // Only the Latin font files download for this page; the other subsets stay on the server.
  if (suffix && (suffix !== ".woff2" || entry.name.includes("latin-wght-normal"))) {
    totals[suffix] += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
}

let over = false;
for (const [suffix, limit] of Object.entries(LIMITS)) {
  console.log(`${suffix}: ${totals[suffix]} / ${limit} bytes`);
  over ||= totals[suffix] > limit;
}
if (over) process.exit(1);
