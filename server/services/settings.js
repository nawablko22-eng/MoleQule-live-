// Backs a handful of credentials with the database instead of .env, so a
// teacher can type them into an in-app Settings page and have the
// connection go live immediately — no editing .env, no restarting the
// server. get() checks the database first and falls back to the matching
// process.env variable, so a deployment that's always used .env for these
// keeps working exactly as before; set() writes to the database (and this
// process's own env, so the very next request already sees it too).

const db = require("../db");

// Hydrate process.env from the database once, as soon as this module is
// first required (early in index.js's require chain) — so anything that
// reads process.env.GOOGLE_CLIENT_ID directly (services/googleAuth.js,
// for "Continue with Google" sign-in, which intentionally reuses the same
// credentials as YouTube) sees a value saved from Settings even after a
// server restart, without needing to be rewritten to call settings.get()
// itself. A value already set in .env wins if the database doesn't have
// that key at all; once Settings has saved a key, the database wins from
// then on (it's the more recently-active source of truth).
for (const row of db.prepare("SELECT key, value FROM settings").all()) {
  if (row.value) process.env[row.key] = row.value;
}

function get(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (row && row.value) return row.value;
  return process.env[key] || "";
}

function set(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
  process.env[key] = value; // so code that still reads process.env directly sees it too, same request cycle
}

function has(key) {
  return Boolean(get(key));
}

module.exports = { get, set, has };
