import { describe, it, expect } from "vitest";
import { db } from "../db.js";
import { cacheKey, getCached, putCached, type CacheKeyInput } from "./cache.js";

const GOA_TRIP: CacheKeyInput = {
  feature: "itinerary",
  destinationId: "goa",
  start: "2026-12-25",
  end: "2026-12-28",
  model: "claude-sonnet-5",
};

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
    const bare: CacheKeyInput = { feature: "packing", model: "gpt-5" };
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
    });
    expect(alice).toBe(bob);
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
    expect(getCached(cacheKey({ feature: "budget", model: "miss-model" }))).toBeNull();
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
