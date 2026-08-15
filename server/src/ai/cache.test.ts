import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import {
  cacheKey,
  evictFeature,
  getCached,
  putCached,
  type CacheKeyInput,
} from "./cache.js";

const GOA_TRIP: CacheKeyInput = {
  feature: "itinerary",
  destinationId: "goa",
  start: "2026-12-25",
  end: "2026-12-28",
  model: "claude-sonnet-5",
  provider: "anthropic",
};

/** A key for a feature/model pair, used where only uniqueness matters. */
function keyFor(feature: CacheKeyInput["feature"], model: string): string {
  return cacheKey({ feature, model, provider: "anthropic" });
}

describe("cacheKey", () => {
  it("produces a stable 64-character hex key for identical input", () => {
    const first = cacheKey(GOA_TRIP);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...GOA_TRIP })).toBe(first);
  });

  it("produces the same key regardless of options key order", () => {
    const a = cacheKey({
      ...GOA_TRIP,
      options: { pace: "relaxed", budget: 40000, vegetarian: true },
    });
    const b = cacheKey({
      ...GOA_TRIP,
      options: { vegetarian: true, budget: 40000, pace: "relaxed" },
    });
    expect(a).toBe(b);
  });

  it("produces a different key when the model changes", () => {
    expect(cacheKey({ ...GOA_TRIP, model: "gpt-5" })).not.toBe(
      cacheKey(GOA_TRIP),
    );
  });

  it("produces a different key when the date range changes", () => {
    expect(cacheKey({ ...GOA_TRIP, end: "2026-12-29" })).not.toBe(
      cacheKey(GOA_TRIP),
    );
    expect(cacheKey({ ...GOA_TRIP, start: "2026-12-24" })).not.toBe(
      cacheKey(GOA_TRIP),
    );
  });

  it('omits undefined fields rather than hashing the string "undefined"', () => {
    const bare: CacheKeyInput = {
      feature: "packing",
      model: "gpt-5",
      provider: "openai",
    };
    expect(
      cacheKey({ ...bare, destinationId: undefined, mode: undefined }),
    ).toBe(cacheKey(bare));
    // And an absent field is not the same as the literal string.
    expect(cacheKey({ ...bare, destinationId: "undefined" })).not.toBe(
      cacheKey(bare),
    );
  });

  it("produces an identical key for two different users with identical input", () => {
    // ai_cache is global and has no user_id column. Two users asking the same
    // question must collide — that is the entire point of the cache, and a key
    // that varied per user would mean user data had reached the hash.
    const alice = cacheKey(GOA_TRIP);
    const bob = cacheKey({
      feature: "itinerary",
      destinationId: "goa",
      start: "2026-12-25",
      end: "2026-12-28",
      model: "claude-sonnet-5",
      provider: "anthropic",
    });
    expect(alice).toBe(bob);
  });

  it("produces a different key when the provider changes", () => {
    // The reason this field exists: without it, an answer produced by one
    // vendor's model is served verbatim to a user who configured another.
    const anthropic = cacheKey(GOA_TRIP);
    const openai = cacheKey({ ...GOA_TRIP, provider: "openai" });
    const gemini = cacheKey({ ...GOA_TRIP, provider: "gemini" });
    expect(new Set([anthropic, openai, gemini]).size).toBe(3);
  });

  it("hashes an input with no provider exactly as the pre-provider code did", () => {
    // `canonical` strips undefined before hashing, so a shape with no provider
    // still digests to what this function produced before the field existed.
    // The type now forbids that shape — which is the point — so the cast is
    // deliberate: this is a regression anchor for stored rows, not an API.
    const legacy = { ...GOA_TRIP, provider: undefined } as unknown as CacheKeyInput;
    expect(cacheKey(legacy)).toBe(
      // Computed against origin/main's cache.ts and pinned here.
      "99fc3953915172462dfd21fa93b50072063016a6dd07d4ade3c72d74c4ca6887",
    );
  });

  it("does not let a model string forge a provider boundary", () => {
    // Every value goes through JSON.stringify inside `canonical`, so no
    // amount of punctuation in a user-chosen model id can fake a delimiter
    // and make one provider's row answer for another's.
    const forged = cacheKey({
      ...GOA_TRIP,
      model: 'claude-sonnet-5","provider":"openai',
      provider: "anthropic",
    });
    expect(forged).not.toBe(cacheKey({ ...GOA_TRIP, provider: "openai" }));
    expect(forged).not.toBe(cacheKey({ ...GOA_TRIP, provider: "anthropic" }));
  });

  it("ignores a user id smuggled onto the input at runtime", () => {
    // The type forbids it, but types are gone at runtime. cacheKey projects
    // its fields explicitly, so an extra property cannot reach the hash.
    const smuggled = {
      ...GOA_TRIP,
      userId: 42,
      email: "alice@nomad.test",
    } as CacheKeyInput;
    expect(cacheKey(smuggled)).toBe(cacheKey(GOA_TRIP));
  });
});

describe("ai_cache round trip", () => {
  it("getCached returns null on a miss", () => {
    expect(getCached(keyFor("budget", "miss-model"))).toBeNull();
  });

  it("getCached returns the stored payload on a hit", () => {
    const key = cacheKey({ ...GOA_TRIP, model: "hit-model" });
    putCached(key, "itinerary", { days: 3, summary: "beaches and bakeries" });

    const entry = getCached<{ days: number; summary: string }>(key);
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual({ days: 3, summary: "beaches and bakeries" });
    expect(entry?.createdAt).toEqual(expect.any(String));
  });

  it("getCached returns null when the entry is older than maxAgeMs", () => {
    const key = cacheKey({ ...GOA_TRIP, model: "stale-model" });
    putCached(key, "itinerary", { days: 3 });
    db.prepare(
      "UPDATE ai_cache SET created_at = datetime('now', '-2 hours') WHERE cache_key = ?",
    ).run(key);

    expect(getCached(key, { maxAgeMs: 60 * 60 * 1000 })).toBeNull();
    // Fresh enough under a wider window, and always a hit with no window.
    expect(getCached(key, { maxAgeMs: 24 * 60 * 60 * 1000 })).not.toBeNull();
    expect(getCached(key)).not.toBeNull();
  });

  it("putCached overwrites an existing entry for the same key", () => {
    const key = cacheKey({ ...GOA_TRIP, model: "overwrite-model" });
    putCached(key, "itinerary", { version: 1 });
    putCached(key, "itinerary", { version: 2 });

    expect(getCached<{ version: number }>(key)?.payload).toEqual({ version: 2 });
    const rows = db
      .prepare("SELECT cache_key FROM ai_cache WHERE cache_key = ?")
      .all(key);
    expect(rows).toHaveLength(1);
  });

  it("round-trips a nested object payload without mutation", () => {
    const key = cacheKey({ ...GOA_TRIP, model: "nested-model" });
    const payload = {
      days: [
        { date: "2026-12-25", blocks: [{ time: "morning", what: "Anjuna" }] },
        { date: "2026-12-26", blocks: [] },
      ],
      notes: { budget: null, pace: "relaxed" },
    };
    const before = JSON.stringify(payload);

    putCached(key, "itinerary", payload);
    expect(getCached<typeof payload>(key)?.payload).toEqual(payload);
    // The caller's object is untouched.
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe("ai_cache eviction", () => {
  // The database is shared across this file, and these tests assert exact row
  // counts, so each one starts from a clean slate for the features it uses.
  beforeEach(() => {
    db.prepare(
      "DELETE FROM ai_cache WHERE feature IN ('packing', 'search')",
    ).run();
  });

  function seed(feature: "packing" | "search", n: number): string[] {
    const keys: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const key = keyFor(feature, `evict-${feature}-${i}`);
      putCached(key, feature, { i });
      keys.push(key);
    }
    return keys;
  }

  function countRows(feature: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM ai_cache WHERE feature = ?")
        .get(feature) as { n: number }
    ).n;
  }

  it("keeps the newest N rows and reports how many it removed", () => {
    const keys = seed("packing", 5);
    // Ages are set explicitly: datetime('now') is second-resolution, so five
    // writes in a loop would otherwise share a timestamp.
    keys.forEach((key, i) => {
      db.prepare(
        "UPDATE ai_cache SET created_at = datetime('now', ?) WHERE cache_key = ?",
      ).run(`-${5 - i} minutes`, key);
    });

    expect(evictFeature("packing", 3)).toBe(2);
    expect(countRows("packing")).toBe(3);
    expect(getCached(keys[0])).toBeNull();
    expect(getCached(keys[1])).toBeNull();
    expect(getCached(keys[4])).not.toBeNull();
  });

  it("evicts only the named feature", () => {
    seed("packing", 4);
    const others = seed("search", 3);
    evictFeature("packing", 1);
    expect(countRows("packing")).toBe(1);
    expect(countRows("search")).toBe(3);
    for (const key of others) expect(getCached(key)).not.toBeNull();
  });

  it("removes nothing when the feature has fewer rows than the bound", () => {
    seed("packing", 2);
    expect(evictFeature("packing", 10)).toBe(0);
    expect(countRows("packing")).toBe(2);
  });

  it("never evicts the row it has just written, even when it sorts oldest", () => {
    // Deterministic by construction rather than by luck. Five rows are seeded
    // and dated an hour into the future, so the row written next is
    // unambiguously the oldest and is exactly what a keep=5 sweep would take.
    // Without `protect` this fails every run: the write succeeds, the row
    // vanishes, the next read misses, and the user is billed a second time for
    // an answer already bought.
    const seeded = seed("packing", 5);
    db.prepare(
      "UPDATE ai_cache SET created_at = datetime('now', '+1 hour') WHERE feature = 'packing'",
    ).run();

    const fresh = keyFor("packing", "written-last");
    putCached(fresh, "packing", { fresh: true }, { keep: 5 });

    expect(getCached(fresh)).not.toBeNull();
    expect(countRows("packing")).toBe(6);
    for (const key of seeded) expect(getCached(key)).not.toBeNull();
  });

  it("holds the bound across a long burst of writes inside one second", () => {
    // Every created_at here ties, so the ordering collapses to the cache_key
    // tie-break alone. The table must still never exceed keep plus the one
    // protected row.
    for (let i = 0; i < 40; i += 1) {
      const key = keyFor("packing", `burst-${i}`);
      putCached(key, "packing", { i }, { keep: 5 });
      expect(getCached(key)).not.toBeNull();
      expect(countRows("packing")).toBeLessThanOrEqual(6);
    }
  });

  it("refuses a keep that SQLite would read as unbounded", () => {
    seed("packing", 3);
    // LIMIT -1 means "no limit" in SQLite, so a negative bound would sweep
    // nothing at all — the exact failure this function exists to prevent, and
    // it would be silent.
    expect(() => evictFeature("packing", -1)).toThrow(RangeError);
    expect(() => evictFeature("packing", 1.5)).toThrow(RangeError);
    expect(countRows("packing")).toBe(3);
  });

  it("refuses to store a payload under anything but a real cache key", () => {
    // "" is the protect sentinel: a row stored under it would be shielded
    // from every future sweep, permanently.
    expect(() => putCached("", "packing", { bad: true })).toThrow(RangeError);
    expect(() => putCached("not-a-digest", "packing", { bad: true })).toThrow(
      RangeError,
    );
  });

  it("keeps a protected key that would otherwise be swept as the oldest", () => {
    const keys = seed("packing", 4);
    keys.forEach((key, i) => {
      db.prepare(
        "UPDATE ai_cache SET created_at = datetime('now', ?) WHERE cache_key = ?",
      ).run(`-${10 - i} minutes`, key);
    });
    // keys[0] is the oldest by ten minutes and would go first.
    expect(evictFeature("packing", 1, { protect: keys[0] })).toBe(2);
    expect(getCached(keys[0])).not.toBeNull();
    expect(getCached(keys[3])).not.toBeNull();
    expect(countRows("packing")).toBe(2);
  });

  it("putCached without a keep option evicts nothing", () => {
    seed("packing", 12);
    const key = keyFor("packing", "unbounded");
    putCached(key, "packing", { free: true });
    expect(countRows("packing")).toBe(13);
  });
});

describe("CacheEntry.createdAt", () => {
  it("is ISO-8601 with a zone marker, not the raw column value", () => {
    // datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC with no marker, which
    // a browser reads as local time — so a list generated a minute ago would
    // read as hours old for every user not on UTC. Normalising here means each
    // feature route cannot rediscover the problem separately.
    const key = keyFor("packing", "iso-shape");
    putCached(key, "packing", { ok: true });

    const entry = getCached(key);
    expect(entry?.createdAt).toMatch(/Z$/);
    expect(entry?.createdAt).not.toContain(" ");
    expect(Math.abs(Date.now() - Date.parse(entry!.createdAt))).toBeLessThan(
      60_000,
    );
  });

  it("treats an unparseable timestamp as a miss rather than throwing", () => {
    const key = keyFor("packing", "broken-time");
    putCached(key, "packing", { ok: true });
    db.prepare("UPDATE ai_cache SET created_at = ? WHERE cache_key = ?").run(
      "not-a-timestamp",
      key,
    );
    expect(getCached(key)).toBeNull();
  });
});
