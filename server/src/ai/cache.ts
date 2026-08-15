import { createHash } from "node:crypto";
import { db } from "../db.js";
import type { AiFeature, ProviderId } from "./provider.js";

/**
 * Everything that changes the answer, and nothing that identifies who asked.
 * There is no `userId` field and no index signature one could be smuggled
 * through — and `cacheKey` projects these fields explicitly, so a stray
 * property on a runtime object cannot reach the hash either.
 */
export interface CacheKeyInput {
  feature: AiFeature;
  destinationId?: string;
  start?: string;
  end?: string;
  mode?: string;
  model: string;
  /**
   * The vendor that produced the answer.
   *
   * `model` alone is not enough. Two vendors sharing a model id string would
   * collide today, and the moment an adapter with caller-chosen model names
   * exists — a local model, an OpenAI-compatible gateway — one user's answer
   * gets served to a user who configured a different vendor entirely.
   *
   * Required, not optional. An optional field would not remove the problem, it
   * would move it: every feature route would have to *remember* to pass one,
   * with nothing but review behind it, which is the exact objection that ruled
   * out threading it through `options`. Every AiFeature is a model call, so
   * every caller has a provider; making the compiler say so costs one keyword.
   */
  provider: ProviderId;
  /** Anything else that changes the answer. Key order is irrelevant. */
  options?: Record<string, string | number | boolean | null>;
}

export interface CacheEntry<T> {
  payload: T;
  createdAt: string;
}

/** Key-sorted and undefined-stripped, so key order and absent fields cannot
 *  produce two hashes for one question. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

/** sha256 over canonical (key-sorted, undefined-stripped) JSON. Hex, 64 chars. */
export function cacheKey(input: CacheKeyInput): string {
  // Projected field by field on purpose. ai_cache is global: two users asking
  // the same question must collide, so nothing user-identifying may reach the
  // hash even if a caller hands us an object carrying extra properties.
  return createHash("sha256")
    .update(
      canonical({
        feature: input.feature,
        destinationId: input.destinationId,
        start: input.start,
        end: input.end,
        mode: input.mode,
        model: input.model,
        provider: input.provider,
        options: input.options,
      }),
    )
    .digest("hex");
}

const selectEntry = db.prepare(
  "SELECT payload, created_at AS createdAt FROM ai_cache WHERE cache_key = ?",
);

const upsertEntry = db.prepare(`
  INSERT INTO ai_cache (cache_key, feature, payload) VALUES (?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    feature    = excluded.feature,
    payload    = excluded.payload,
    created_at = datetime('now')
`);

/** `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function parseStoredTime(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export function getCached<T>(
  key: string,
  opts?: { maxAgeMs?: number },
): CacheEntry<T> | null {
  const row = selectEntry.get(key) as
    | { payload: string; createdAt: string }
    | undefined;
  if (!row) return null;

  if (opts?.maxAgeMs !== undefined) {
    const age = Date.now() - parseStoredTime(row.createdAt);
    // An unparseable timestamp is treated as a miss, not as fresh.
    if (!Number.isFinite(age) || age > opts.maxAgeMs) return null;
  }

  return { payload: JSON.parse(row.payload) as T, createdAt: row.createdAt };
}

/**
 * Two details in here are load-bearing.
 *
 * `ORDER BY created_at DESC, cache_key DESC` — `datetime('now')` resolves to
 * the second, so a burst of writes shares a timestamp and without the
 * tie-break SQLite may return any "newest N" it likes. The secondary sort
 * makes the survivor set a pure function of the table's contents.
 *
 * `cache_key <> ?` — the tie-break alone is *not* enough to protect a fresh
 * write. When every row in the second ties, the ordering collapses to
 * `cache_key DESC`, and a newly written key that happens to sort low is
 * evicted by its own sweep. The next read then misses and re-bills the user
 * for the answer we just paid for, which is precisely what the cache exists
 * to prevent. So the row being written is excluded explicitly.
 *
 * Driven by idx_ai_cache_feature(feature, created_at), which already existed.
 */
const evictOldest = db.prepare(`
  DELETE FROM ai_cache
   WHERE feature = ?
     AND cache_key <> ?
     AND cache_key NOT IN (
           SELECT cache_key FROM ai_cache
            WHERE feature = ?
            ORDER BY created_at DESC, cache_key DESC
            LIMIT ?
         )
`);

/**
 * Trims one feature's rows to the `keep` most recently written, returning how
 * many were removed. `protect` is never evicted regardless of its age.
 *
 * Least-recently-*written*, not least-recently-used. True LRU needs a
 * `last_read_at` column, which means an ALTER TABLE in a repo with no migration
 * runner and — worse — turns every cache read into a write. `getCached` would
 * stop being idempotent, which is a nasty property for something tests call in
 * a loop. Age-based expiry is `getCached`'s `maxAgeMs`; this bound is about
 * space, and for space, write recency is a fine proxy.
 */
export function evictFeature(
  feature: AiFeature,
  keep: number,
  opts?: { protect?: string },
): number {
  // SQLite reads a negative LIMIT as "no limit", so `evictFeature(f, -1)` would
  // quietly delete nothing at all. A bound that silently becomes unbounded is
  // the single failure this function exists to prevent, so it is a throw.
  if (!Number.isInteger(keep) || keep < 0) {
    throw new RangeError("evictFeature: keep must be a non-negative integer");
  }
  // "" cannot collide with a real key — `assertCacheKey` guarantees every
  // stored key is 64 hex characters — so it is a safe "protect nothing"
  // sentinel and keeps the statement single-shape. NULL would not work:
  // `cache_key <> NULL` is NULL, which disables the whole DELETE.
  return evictOldest.run(feature, opts?.protect ?? "", feature, keep).changes;
}

const writeThenEvict = db.transaction(
  (key: string, feature: AiFeature, payload: string, keep: number) => {
    upsertEntry.run(key, feature, payload);
    evictOldest.run(feature, key, feature, keep);
  },
);

/**
 * Every row's key must be `cacheKey()` output. Nothing enforced this, and the
 * gap is not cosmetic: a single `putCached("", …)` would write a row that the
 * `protect` sentinel then shields from every future sweep, permanently.
 */
function assertCacheKey(key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new RangeError("cache key must be a 64-character sha256 hex digest");
  }
}

/**
 * `keep` omitted means no sweep at all, so callers written before eviction
 * existed behave exactly as they did.
 */
export function putCached<T>(
  key: string,
  feature: AiFeature,
  payload: T,
  opts?: { keep?: number },
): void {
  assertCacheKey(key);
  const keep = opts?.keep;
  if (keep === undefined) {
    upsertEntry.run(key, feature, JSON.stringify(payload));
    return;
  }
  // One transaction, so a concurrent WAL reader never observes the table
  // between the insert and the sweep.
  writeThenEvict(key, feature, JSON.stringify(payload), keep);
}
