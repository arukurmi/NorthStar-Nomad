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
`);
