import { createHash } from "node:crypto";
import { db } from "../db.js";
import type { AiFeature } from "./provider.js";

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

export function putCached<T>(key: string, feature: AiFeature, payload: T): void {
  upsertEntry.run(key, feature, JSON.stringify(payload));
}
