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
