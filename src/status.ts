import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { activePauses, describePause } from "./pause.js";
import { allStyles } from "./styles.js";
import { formatDateTime, localDay } from "./time.js";
import { spending, usd } from "./usage.js";

// The admin's /status: is Friday healthy, which version runs, and what it has cost so far.

const startedAt = new Date();

// Read once at startup, so it names the code that is running even after a `git pull` that hasn't restarted it yet.
const version = (() => {
  try {
    const args = ["log", "-1", "--format=%h, %cd", "--date=format:%d-%m-%Y"];
    return execFileSync("git", args, { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "tidak diketahui";
  }
})();

/** 93_784_000 ms → "1 hari 2 jam 3 menit". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const parts = [
    [Math.floor(minutes / 1440), "hari"],
    [Math.floor(minutes / 60) % 24, "jam"],
    [minutes % 60, "menit"],
  ].filter(([n]) => n) as [number, string][];
  return parts.length ? parts.map(([n, unit]) => `${n} ${unit}`).join(" ") : "kurang dari 1 menit";
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
const rupiah = (dollars: number) => `Rp${Math.round(dollars * config.USD_TO_IDR).toLocaleString("id-ID")}`;

function dbSize(): number {
  return [config.dbPath, `${config.dbPath}-wal`].reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
}

export function statusReport(now = new Date()): string {
  const today = localDay(now);
  const day = spending(today, today);
  const month = spending(`${today.slice(0, 7)}-01`, `${today.slice(0, 7)}-31`);
  const reminders = (db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE active = 1").get() as { n: number }).n;
  const pauses = activePauses(now.getTime());
  const styles = allStyles();
  return [
    [
      "🩺 *Status Friday*",
      `✅ Menyala ${duration(now.getTime() - startedAt.getTime())} (sejak ${formatDateTime(startedAt)})`,
      `Versi: ${version}`,
      `Model: ${config.FRIDAY_MODEL} (effort ${config.FRIDAY_EFFORT})`,
      `Memori: ${mb(process.memoryUsage().rss)} · database ${mb(dbSize())}`,
      `Pengingat aktif: ${reminders}`,
    ].join("\n"),
    [
      "💰 *Biaya Claude (perkiraan)*",
      `Hari ini: ${usd(day.dollars)} ≈ ${rupiah(day.dollars)} · ${day.people} orang`,
      `Bulan ini: ${usd(month.dollars)} ≈ ${rupiah(month.dollars)} · ${month.people} orang`,
      `_Kurs ${config.USD_TO_IDR.toLocaleString("id-ID")}; rincian per orang: /usage_`,
    ].join("\n"),
    pauses.length ? ["⏸️ *Didiamkan*", ...pauses.map((p) => `- ${describePause(p)}`)].join("\n") : "🔊 Tidak ada chat yang didiamkan.",
    ...(styles.length ? [["🎭 *Gaya khusus*", ...styles.map((s) => `- ${s.chatName}: ${s.style}`)].join("\n")] : []),
  ].join("\n\n");
}
