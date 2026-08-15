/**
 * A sliding-window counter, in memory, with no new dependency. Deliberately
 * small: this process is single-node and the SQLite file is local, so a shared
 * store would buy nothing a Map does not already give.
 *
 * It is not a general-purpose limiter — it exists because `POST /api/ai/keys`
 * both derives a scrypt key and makes a live call to a third-party vendor with
 * a credential the caller supplies. Unlimited, that endpoint is a free
 * credential-validation oracle pointed at Anthropic, Google and OpenAI.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the oldest hit in the window expires. 0 when allowed. */
  retryAfter: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitDecision;
  reset(): void;
}

/** Keeps the map from growing without bound if keys stop recurring. */
const SWEEP_AT = 10_000;

export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
}): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key, now = Date.now()) {
      const cutoff = now - opts.windowMs;
      if (hits.size > SWEEP_AT) {
        for (const [k, times] of hits) {
          if (times[times.length - 1] <= cutoff) hits.delete(k);
        }
      }
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        const oldest = recent[0];
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((oldest + opts.windowMs - now) / 1000)),
        };
      }
      recent.push(now);
      hits.set(key, recent);
      return { allowed: true, retryAfter: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}
