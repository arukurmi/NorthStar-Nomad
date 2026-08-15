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
   * The vendor that produced the answer. Optional only so that an input
   * without it hashes exactly as it did before this field existed; every
   * feature route passes it.
   *
   * `model` alone is not enough. Two vendors sharing a model id string would
   * collide today, and the moment an adapter with caller-chosen model names
   * exists — a local model, an OpenAI-compatible gateway — one user's answer
   * gets served to a user who configured a different vendor entirely.
   */
  provider?: ProviderId;
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
 * `ORDER BY created_at DESC, cache_key DESC` — the tie-break is not cosmetic.
 * `datetime('now')` has one-second resolution, so a burst of writes inside one
 * second leaves SQLite free to pick any order, and the sweep can then evict the
 * row it has just written. The secondary sort makes the survivor set a pure
 * function of the table's contents.
 *
 * Driven by idx_ai_cache_feature(feature, created_at), which already existed.
 */
const evictOldest = db.prepare(`
  DELETE FROM ai_cache
   WHERE feature = ?
     AND cache_key NOT IN (
           SELECT cache_key FROM ai_cache
            WHERE feature = ?
            ORDER BY created_at DESC, cache_key DESC
            LIMIT ?
         )
`);

/**
 * Trims one feature's rows to the `keep` most recently written, returning how
 * many were removed.
 *
 * Least-recently-*written*, not least-recently-used. True LRU needs a
 * `last_read_at` column, which means an ALTER TABLE in a repo with no migration
 * runner and — worse — turns every cache read into a write. `getCached` would
 * stop being idempotent, which is a nasty property for something tests call in
 * a loop. Age-based expiry is `getCached`'s `maxAgeMs`; this bound is about
 * space, and for space, write recency is a fine proxy.
 */
export function evictFeature(feature: AiFeature, keep: number): number {
  return evictOldest.run(feature, feature, keep).changes;
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
  const keep = opts?.keep;
  if (keep === undefined) {
    upsertEntry.run(key, feature, JSON.stringify(payload));
    return;
  }
  // One transaction, so a concurrent WAL reader never observes the table
  // between the insert and the sweep.
  writeThenEvict(key, feature, JSON.stringify(payload), keep);
}

const writeThenEvict = db.transaction(
  (key: string, feature: AiFeature, payload: string, keep: number) => {
    upsertEntry.run(key, feature, payload);
    evictOldest.run(feature, feature, keep);
  },
);
