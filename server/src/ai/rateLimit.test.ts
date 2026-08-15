import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimit.js";

describe("rate limiter", () => {
  it("allows exactly `limit` hits inside the window", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    const now = 1_000_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("a", now + 1).allowed).toBe(true);
    expect(limiter.check("a", now + 2).allowed).toBe(true);
    expect(limiter.check("a", now + 3).allowed).toBe(false);
  });

  it("reports the seconds until the oldest hit leaves the window", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const now = 1_000_000;
    limiter.check("a", now);
    const blocked = limiter.check("a", now + 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(50);
  });

  it("slides: an old hit stops counting once the window passes it", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    const now = 1_000_000;
    limiter.check("a", now);
    limiter.check("a", now + 100);
    expect(limiter.check("a", now + 200).allowed).toBe(false);
    // The first two hits have aged out; the third is allowed again.
    expect(limiter.check("a", now + 1101).allowed).toBe(true);
  });

  it("keeps separate budgets per key", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    const now = 1_000_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("b", now).allowed).toBe(true);
    expect(limiter.check("a", now).allowed).toBe(false);
  });

  it("never reports a retryAfter of zero while blocking", () => {
    // A client that reads retryAfter and waits must not spin.
    const limiter = createRateLimiter({ limit: 1, windowMs: 500 });
    const now = 1_000_000;
    limiter.check("a", now);
    expect(limiter.check("a", now + 499).retryAfter).toBe(1);
  });
});
