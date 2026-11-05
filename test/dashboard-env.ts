/**
 * Imported before setup.ts by the dashboard tests: a temp backup folder (setup.ts may swap in one inside its temp data
 * dir; the tests fill whichever config ends up with), a few roles for the people rows, Smart Life switched on (its API
 * is never called), the timezone the heatmap is checked in, and spending alerts low enough that a few dollars trip them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "friday-backups-"));
process.env.TIMEZONE = "Asia/Jakarta";
process.env.ERRAND_USERS = "6282222222222";
process.env.ONEHUB_USERS = "6281111111111";
process.env.TUYA_ACCESS_ID = "tuya-test-id";
process.env.TUYA_ACCESS_SECRET = "tuya-test-secret";
process.env.TUYA_UID = "tuya-test-uid";
process.env.TUYA_REGION = "sg";
process.env.TUYA_USERS = "6283333333333";
process.env.USAGE_ALERT_DAILY_TOTAL = "3";
process.env.USAGE_ALERT_DAILY_PERSON = "2";
