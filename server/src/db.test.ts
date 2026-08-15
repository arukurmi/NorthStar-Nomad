import { describe, it, expect } from "vitest";
import { db } from "./db.js";

/** A real user row — ai_keys.user_id references users(id). */
function makeUser(email: string): number {
  const info = db
    .prepare(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
    )
    .run("Schema Nomad", email, "not-a-real-hash");
  return Number(info.lastInsertRowid);
}

/** A real trip row — trip_packing.trip_id references trips(id). */
function makeTrip(userId: number): number {
  const info = db
    .prepare(
      `INSERT INTO trips (user_id, destination_id, destination_name, start, end, mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, "spiti", "Spiti Valley", "2026-06-12", "2026-06-18", "bike");
  return Number(info.lastInsertRowid);
}

function sealed(): [Buffer, Buffer, Buffer, Buffer, string] {
  return [
    Buffer.from("ciphertext"),
    Buffer.alloc(12, 1),
    Buffer.alloc(16, 2),
    Buffer.alloc(16, 3),
    "abcd",
  ];
}

describe("ai schema", () => {
  it("creates ai_keys, ai_cache, ai_usage, ai_prefs tables", () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("ai_keys");
    expect(names).toContain("ai_cache");
    expect(names).toContain("ai_usage");
    expect(names).toContain("ai_prefs");
  });

  it("enforces the (user_id, provider) composite primary key on ai_keys", () => {
    const userId = makeUser("pk@nomad.test");
    const other = makeUser("pk-other@nomad.test");
    const insert = db.prepare(
      `INSERT INTO ai_keys (user_id, provider, ciphertext, iv, tag, salt, last4)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(userId, "anthropic", ...sealed());

    // Same user, same provider is forbidden by the composite key.
    expect(() => insert.run(userId, "anthropic", ...sealed())).toThrow(
      /UNIQUE constraint failed/i,
    );
    // A different provider, and a different user, are both fine.
    expect(() => insert.run(userId, "openai", ...sealed())).not.toThrow();
    expect(() => insert.run(other, "anthropic", ...sealed())).not.toThrow();
  });

  it("rejects a provider outside the CHECK constraint", () => {
    const userId = makeUser("check@nomad.test");
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_keys (user_id, provider, ciphertext, iv, tag, salt, last4)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, "skynet", ...sealed()),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      db
        .prepare("INSERT INTO ai_prefs (user_id, provider) VALUES (?, ?)")
        .run(userId, "skynet"),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("creates idx_ai_usage_user and idx_ai_cache_feature", () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("idx_ai_usage_user");
    expect(names).toContain("idx_ai_cache_feature");
  });

  it("creates trip_packing with a (trip_id, item_key) composite primary key", () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("trip_packing");

    const tripId = makeTrip(makeUser("packing-pk@nomad.test"));
    const insert = db.prepare(
      `INSERT INTO trip_packing (trip_id, item_key, category, label)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run(tripId, "0123456789abcdef", "Clothing", "Thermals");

    expect(() =>
      insert.run(tripId, "0123456789abcdef", "Gear", "Something else"),
    ).toThrow(/UNIQUE constraint failed/i);
    // The same item key under a different trip is a different checkbox.
    const otherTrip = makeTrip(makeUser("packing-pk-other@nomad.test"));
    expect(() =>
      insert.run(otherTrip, "0123456789abcdef", "Clothing", "Thermals"),
    ).not.toThrow();
  });

  it("rejects a qty below 1 and a checked value outside 0/1", () => {
    const tripId = makeTrip(makeUser("packing-check@nomad.test"));
    const insert = db.prepare(
      `INSERT INTO trip_packing (trip_id, item_key, category, label, qty, checked)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insert.run(tripId, "aaaaaaaaaaaaaaaa", "Gear", "Tool kit", 0, 0),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insert.run(tripId, "bbbbbbbbbbbbbbbb", "Gear", "Tool kit", 1, 2),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insert.run(tripId, "cccccccccccccccc", "Gear", "Tool kit", 1, 1),
    ).not.toThrow();
  });

  it("trip_packing has no user_id column", () => {
    // Ownership is resolved through trips.user_id on every statement. A
    // user_id here would be a second source of truth that can disagree.
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('trip_packing')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "trip_id",
      "item_key",
      "category",
      "label",
      "qty",
      "reason",
      "sort_order",
      "checked",
      "updated_at",
    ]);
    expect(columns).not.toContain("user_id");
  });

  it("ai_cache has no user_id column", () => {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('ai_cache')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "cache_key",
      "feature",
      "payload",
      "created_at",
    ]);
    expect(columns).not.toContain("user_id");
  });
});
