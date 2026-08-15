import Database from "better-sqlite3";

/** In-memory DB for tests; file DB otherwise (NOMAD_DB overrides the path). */
const dbPath =
  process.env.NODE_ENV === "test"
    ? ":memory:"
    : (process.env.NOMAD_DB ?? "data.sqlite");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    destination_id TEXT NOT NULL,
    destination_name TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'flight',
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'taken', 'skipped')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

  CREATE TABLE IF NOT EXISTS ai_keys (
    user_id      INTEGER NOT NULL REFERENCES users(id),
    provider     TEXT    NOT NULL
      CHECK (provider IN ('anthropic', 'gemini', 'openai')),
    ciphertext   BLOB    NOT NULL,
    iv           BLOB    NOT NULL,
    tag          BLOB    NOT NULL,
    salt         BLOB    NOT NULL,
    last4        TEXT    NOT NULL,
    model        TEXT,
    validated_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider)
  );

  CREATE TABLE IF NOT EXISTS ai_prefs (
    user_id  INTEGER NOT NULL PRIMARY KEY REFERENCES users(id),
    provider TEXT    NOT NULL
      CHECK (provider IN ('anthropic', 'gemini', 'openai'))
  );

  CREATE TABLE IF NOT EXISTS ai_cache (
    cache_key  TEXT PRIMARY KEY,
    feature    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_cache_feature
    ON ai_cache(feature, created_at);

  CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    feature       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cached        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_usage_user
    ON ai_usage(user_id, feature);

  CREATE TABLE IF NOT EXISTS trip_packing (
    trip_id    INTEGER NOT NULL REFERENCES trips(id),
    item_key   TEXT    NOT NULL,
    category   TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    -- Upper bound mirrors parsePackingList's, so the table and the validator
    -- cannot drift into disagreeing about what a legal quantity is.
    qty        INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
    reason     TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    checked    INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trip_id, item_key)
  );
`);
