/**
 * Imported before setup.ts by the onehub tests: turns onehub on for the admin only (setup.ts's ADMIN), with a fake
 * API (answered by a fetch stub in the test) and, if ONEHUB_TEST_DATABASE_URL is set, a real read-only database.
 */
process.env.ONEHUB_USERS = "6281111111111";
process.env.ONEHUB_API_URL = "http://onehub.test/internal/friday";
process.env.ONEHUB_API_TOKEN = "test-onehub-token";
process.env.ONEHUB_DATABASE_URL = process.env.ONEHUB_TEST_DATABASE_URL ?? "postgres://nobody@127.0.0.1:1/none";
