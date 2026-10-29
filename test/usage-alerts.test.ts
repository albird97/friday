import { ADMIN, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onUsageAlert, recordUsage } from "../src/usage.js";

// Defaults: tell the admin at $20 a day in total and at $5 a day for one person; never block anyone.
const alerts: string[] = [];
onUsageAlert(async (text) => void alerts.push(text));
const output = (tokens: number) => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: tokens, webSearches: 0 });
const day = new Date("2026-10-30T12:00:00+07:00");

describe("spending alerts", () => {
  it("fire once per day per threshold, and only inform", () => {
    recordUsage(ADMIN, "claude-opus-5-5", output(200_000), day); // $4
    assert.deepEqual(alerts, []);
    recordUsage(ADMIN, "claude-opus-5-5", output(100_000), day); // $6 for Albert
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Albert \(\+6281111111111\) sudah memakai \*\$6,00\* hari ini, lewat \$5,00\. Ini hanya pemberitahuan/);

    recordUsage(ADMIN, "claude-opus-5-5", output(50_000), day); // still Albert, no repeat
    assert.equal(alerts.length, 1);

    recordUsage(WIFE, "claude-opus-5-5", output(700_000), day); // Sarah $14, total $21
    assert.equal(alerts.length, 3);
    assert.ok(alerts.some((a) => /Pemakaian Claude hari ini sudah \*\$21,00\*, lewat \$20,00/.test(a)));
    assert.ok(alerts.some((a) => /Sarah .* \*\$14,00\*/.test(a)));

    recordUsage(WIFE, "claude-opus-5-5", output(100_000), new Date("2026-10-31T09:00:00+07:00")); // a new day starts clean
    assert.equal(alerts.length, 3);
  });
});
