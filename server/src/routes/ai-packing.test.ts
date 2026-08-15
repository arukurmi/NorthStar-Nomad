import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { AiError } from "../ai/provider.js";
import type { FakeProvider } from "../ai/providers/fake.js";
import { resetProviders, useFakeProviders } from "../ai/registry.js";
import { MODE_CATEGORY_TITLE, type PackingList } from "../ai/packing.js";
import { MAX_SPAN_DAYS } from "../ai/prompts/packing.js";
import { __resetSaveLimitForTests } from "./ai-keys.js";
import { __resetPackingLimitForTests } from "./ai-packing.js";
import type { TravelMode } from "../types.js";

const app = createApp();

const ANTHROPIC_KEY = "sk-ant-api03-packing-fixture-0123456789abcd";
const OPENAI_KEY = "sk-packing-fixture-openai-0123456789abcd";

/**
 * `datetime('now')` output has no zone marker, and a browser reads such a string
 * as *local* time — so a list generated a minute ago would read as hours old
 * anywhere but UTC. Every `generatedAt` this route emits, on both the miss and
 * the hit path, has to carry one.
 */
const ZONED = /Z$|[+-]\d{2}:\d{2}$/;

/** 16 lowercase hex characters. Derived server-side; the model never sees one. */
const ITEM_KEY = /^[0-9a-f]{16}$/;

/**
 * Stands in for model output, so it is a plain fixture rather than a
 * `PackingList`: the route's parser is what turns it into one, and the
 * `bad_output` case below needs to express a shape `PackingList` forbids.
 */
interface RawItem {
  label: string;
  qty: number;
  reason?: string;
}
interface RawCategory {
  name: string;
  items: RawItem[];
}
interface RawList {
  summary: string;
  categories: RawCategory[];
}

function items(prefix: string): RawItem[] {
  return [
    { label: `${prefix} one`, qty: 3, reason: "The nights run cold up there." },
    { label: `${prefix} two`, qty: 1, reason: "" },
    { label: `${prefix} three`, qty: 2 },
  ];
}

/**
 * Four categories of three items, one of them carrying the heading the prompt
 * dictates for `mode` — so `parsePackingList` flags exactly one `modeCategory`.
 * Rebuilt on every call so a mutation in one test cannot reach another.
 */
function modelPayload(mode: TravelMode): RawList {
  return {
    summary: "Late monsoon on the coast: assume everything gets soaked once.",
    categories: [
      { name: "Clothing", items: items("Clothing") },
      { name: "Gear", items: items("Gear") },
      { name: "Documents", items: items("Documents") },
      { name: MODE_CATEGORY_TITLE[mode], items: items("Mode") },
    ],
  };
}

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Packing Nomad", email, password: "wanderlust1" });
  return res.body.token as string;
}

function saveKey(
  token: string,
  provider: "anthropic" | "openai",
  apiKey: string,
) {
  return request(app)
    .post("/api/ai/keys")
    .set("Authorization", `Bearer ${token}`)
    .send({ provider, apiKey });
}

/** Registers an account with one validated Anthropic key on it. */
async function withKey(email: string): Promise<string> {
  const token = await register(email);
  const saved = await saveKey(token, "anthropic", ANTHROPIC_KEY);
  expect(saved.status).toBe(200);
  return token;
}

function pack(token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/ai/packing")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function completions(fake: FakeProvider): number {
  return fake.calls.filter((call) => call.kind === "complete").length;
}

afterEach(() => {
  resetProviders();
  __resetSaveLimitForTests();
  __resetPackingLimitForTests();
});

describe("POST /api/ai/packing", () => {
  it("401s without a bearer token", async () => {
    const res = await request(app)
      .post("/api/ai/packing")
      .send({ destinationId: "goa", start: "2026-03-10", end: "2026-03-14", mode: "flight" });

    expect(res.status).toBe(401);
    // "your session is gone", not "that API key was rejected" — both are 401s
    // and the client must tell them apart without parsing a message.
    expect(res.body.code).toBe("unauthenticated");
  });

  it("428s with no_key when the account has no key, without calling a provider", async () => {
    const fakes = useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await register("packing-no-key@nomad.test");

    const res = await pack(token, {
      destinationId: "goa",
      start: "2026-03-10",
      end: "2026-03-14",
      mode: "flight",
    });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("no_key");
    // 428 is "you must do something first", which is exactly the state a user
    // with no key is in — and nothing was billed to get there.
    expect(completions(fakes.anthropic)).toBe(0);
    expect(completions(fakes.openai)).toBe(0);
    expect(completions(fakes.gemini)).toBe(0);
  });

  it("generates a list on a miss with 4–6 categories, derived item keys and one mode category", async () => {
    useFakeProviders({ completions: [modelPayload("bike")] });
    const token = await withKey("packing-happy@nomad.test");

    const res = await pack(token, {
      destinationId: "spiti",
      start: "2026-06-01",
      end: "2026-06-07",
      mode: "bike",
    });

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);

    const packing = res.body.packing as PackingList;
    expect(packing.summary).toBeTruthy();
    expect(packing.categories.length).toBeGreaterThanOrEqual(4);
    expect(packing.categories.length).toBeLessThanOrEqual(6);

    const keys = packing.categories.flatMap((c) => c.items.map((i) => i.itemKey));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(ITEM_KEY);
    // Every checkbox is a distinct row; a shared key means one tick lands twice.
    expect(new Set(keys).size).toBe(keys.length);

    // Exactly one section is expanded by default, and the client learns which
    // from a flag rather than by string-matching a heading.
    const flagged = packing.categories.filter((c) => c.modeCategory);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe(MODE_CATEGORY_TITLE.bike);
  });

  it("stamps a zoned generatedAt on both the miss and the hit", async () => {
    useFakeProviders({ completions: [modelPayload("bus")] });
    const token = await withKey("packing-generated-at@nomad.test");
    const body = {
      destinationId: "manali",
      start: "2026-05-02",
      end: "2026-05-06",
      mode: "bus",
    };

    const miss = await pack(token, body);
    expect(miss.status).toBe(200);
    expect(miss.body.cached).toBe(false);
    expect(miss.body.generatedAt).toMatch(ZONED);

    const hit = await pack(token, body);
    expect(hit.status).toBe(200);
    expect(hit.body.cached).toBe(true);
    // The hit path renders `ai_cache.created_at`, which is stored without one.
    expect(hit.body.generatedAt).toMatch(ZONED);
    expect(Number.isNaN(Date.parse(hit.body.generatedAt))).toBe(false);
  });
});

/**
 * Every rejection below is ours, not a vendor's: `code` is `bad_request` and no
 * money changes hands. `MAX_SPAN_DAYS` is read from the prompt module rather
 * than hardcoded, so widening the bound moves this case with it.
 */
describe("POST /api/ai/packing request validation", () => {
  const base = {
    destinationId: "jaipur",
    start: "2026-11-03",
    end: "2026-11-08",
    mode: "flight",
  };

  const rejected: Array<[string, Record<string, unknown>]> = [
    ["an unknown destinationId", { ...base, destinationId: "atlantis" }],
    ["a missing destinationId", { start: base.start, end: base.end, mode: base.mode }],
    ["a malformed start", { ...base, start: "3 November 2026" }],
    // The regex alone would let this one through, and the gap is surprising:
    // V8 reads "2026-02-30T00:00:00Z" as 2 March rather than rejecting it, so a
    // February request would be grounded, answered and cached against March's
    // weather — a wrong answer rather than a loud one.
    ["a start that rolls over into the next month", { ...base, start: "2026-02-30", end: "2026-03-04" }],
    ["a start after the end", { ...base, start: "2026-11-08", end: "2026-11-03" }],
    // 31 days of March plus 9 of April: 40, against a bound of 30.
    [`a span longer than ${MAX_SPAN_DAYS} days`, { ...base, start: "2026-03-01", end: "2026-04-09" }],
    ["a missing mode", { destinationId: base.destinationId, start: base.start, end: base.end }],
    // Never defaulted: a rider handed a flight list gets cabin liquid limits and
    // lost checked baggage, cached under a key that says "bike".
    ["an unsupported mode", { ...base, mode: "train" }],
    ["a tripId sent as a string", { ...base, tripId: "7" }],
    ["a tripId of zero", { ...base, tripId: 0 }],
    ["a fractional tripId", { ...base, tripId: 1.5 }],
  ];

  it("400s every malformed request with code bad_request", async () => {
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-400s@nomad.test");

    for (const [label, body] of rejected) {
      const res = await pack(token, body);
      expect(res.status, `${label} should be a 400`).toBe(400);
      expect(res.body.code, `${label} should be bad_request`).toBe("bad_request");
    }
  });

  it("spends nothing on a rejected request", async () => {
    const fakes = useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-400-no-spend@nomad.test");

    for (const [, body] of rejected) await pack(token, body);

    // Validation runs before the provider call, so a malformed request cannot
    // reach the user's credit — the whole matrix costs zero completions.
    expect(completions(fakes.anthropic)).toBe(0);
    expect(completions(fakes.openai)).toBe(0);
    expect(completions(fakes.gemini)).toBe(0);
  });

  it("describes the rule it broke without echoing the value", async () => {
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-400-no-echo@nomad.test");

    // A body can carry anything a caller's mistake puts there — including, one
    // copy-paste away, a credential. Echoing the offending value back is how it
    // ends up in a screenshot, a log line or a bug report.
    const canaries: Array<[string, Record<string, unknown>]> = [
      ["destinationId", { ...base, destinationId: "sk-ant-CANARY-destination" }],
      ["start", { ...base, start: "sk-ant-CANARY-start" }],
      ["mode", { ...base, mode: "sk-ant-CANARY-mode" }],
      ["tripId", { ...base, tripId: "sk-ant-CANARY-trip" }],
    ];

    for (const [field, body] of canaries) {
      const res = await pack(token, body);
      expect(res.status, `${field} should be a 400`).toBe(400);
      expect(res.text, `${field} was echoed back`).not.toContain("CANARY");
      expect(res.body.error).toBeTruthy();
    }
  });
});

describe("POST /api/ai/packing provider failures", () => {
  const body = {
    destinationId: "udaipur",
    start: "2026-10-05",
    end: "2026-10-09",
    mode: "flight",
  };

  it("maps invalid_key to 401", async () => {
    useFakeProviders({
      completions: [new AiError("invalid_key", "that key was rejected")],
    });
    const token = await withKey("packing-invalid-key@nomad.test");

    const res = await pack(token, body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_key");
  });

  it("maps insufficient_credit to 402", async () => {
    useFakeProviders({
      completions: [
        new AiError("insufficient_credit", "your credit balance is too low"),
      ],
    });
    const token = await withKey("packing-no-credit@nomad.test");

    const res = await pack(token, { ...body, start: "2026-10-12", end: "2026-10-16" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("insufficient_credit");
  });

  it("maps rate_limited to 429 and passes the vendor's Retry-After through", async () => {
    useFakeProviders({
      completions: [
        new AiError("rate_limited", "too many requests", { retryAfter: 41 }),
      ],
    });
    const token = await withKey("packing-vendor-throttled@nomad.test");

    const res = await pack(token, { ...body, start: "2026-10-19", end: "2026-10-23" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(res.body.retryAfter).toBe(41);
    // The header, not just the body: a client backs off on the header.
    expect(res.headers["retry-after"]).toBe("41");
  });

  it("maps provider_error to 502", async () => {
    useFakeProviders({
      completions: [new AiError("provider_error", "could not reach anthropic")],
    });
    const token = await withKey("packing-unreachable@nomad.test");

    const res = await pack(token, { ...body, start: "2026-10-26", end: "2026-10-30" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("provider_error");
  });

  it("502s with bad_output when the model returns too few categories", async () => {
    // Two categories against a floor of four. The adapter runs the route's own
    // parser, so the violation surfaces as bad_output rather than reaching the
    // cache and being served to everyone who asks the same question.
    useFakeProviders({
      completions: [
        {
          summary: "Two categories is not a packing list.",
          categories: [
            { name: "Clothing", items: items("Clothing") },
            { name: "Gear", items: items("Gear") },
          ],
        },
      ],
    });
    const token = await withKey("packing-bad-output@nomad.test");

    const res = await pack(token, { ...body, start: "2026-11-02", end: "2026-11-06" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("bad_output");
    // Model output is untrusted text; it never rides back out in the message.
    expect(res.text).not.toContain("Two categories is not");
  });
});

describe("POST /api/ai/packing rate limit", () => {
  it("429s the thirty-first generation in an hour and names a retryAfter", async () => {
    // One completion only: the first request pays, the other twenty-nine are
    // cache hits. They still cost limiter budget, which is the point — the
    // throttle bounds requests, not spend.
    useFakeProviders({ completions: [modelPayload("flight")] });
    const token = await withKey("packing-throttle@nomad.test");
    const body = {
      destinationId: "goa",
      start: "2026-12-01",
      end: "2026-12-05",
      mode: "flight",
    };

    for (let n = 0; n < 30; n += 1) {
      const res = await pack(token, body);
      expect(res.status, `request ${n + 1} should be allowed`).toBe(200);
    }

    const blocked = await pack(token, body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate_limited");
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retryAfter));
  });
});

describe("POST /api/ai/packing provider selection", () => {
  it("428s naming the provider the caller asked for", async () => {
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-wrong-vendor@nomad.test");

    const res = await pack(token, {
      destinationId: "goa",
      start: "2026-09-07",
      end: "2026-09-11",
      mode: "flight",
      provider: "openai",
    });

    // The account has a working Anthropic key, but the caller named OpenAI and
    // is never silently billed to a vendor they did not ask for.
    expect(res.status).toBe(428);
    expect(res.body.code).toBe("no_key");
    expect(res.body.provider).toBe("openai");
    expect(res.body.error).toMatch(/OpenAI/);
  });

  it("uses the named provider when a key for it exists", async () => {
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-two-vendors@nomad.test");
    expect((await saveKey(token, "openai", OPENAI_KEY)).status).toBe(200);

    const res = await pack(token, {
      destinationId: "goa",
      start: "2026-09-14",
      end: "2026-09-18",
      mode: "flight",
      provider: "openai",
    });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
  });

  it("400s a provider that is not a known vendor", async () => {
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("packing-bogus-vendor@nomad.test");

    const res = await pack(token, {
      destinationId: "goa",
      start: "2026-09-21",
      end: "2026-09-25",
      mode: "flight",
      provider: "not-a-vendor",
    });

    // Not "no preference": falling back would serve `provider=OpenAI` from
    // whichever vendor happens to be first and bill the wrong key.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
  });
});

describe("the throttle runs before anything expensive", () => {
  it("charges budget for a malformed request, not only for a generation", async () => {
    // The ordering in the route is a deliberate claim — a rejected request is
    // indistinguishable from a script's warm-up on its way to a paid one — and
    // without this test, moving validation in front of the limiter would leave
    // the whole suite green while handing an attacker unlimited free attempts.
    const token = await withKey("throttle-order@nomad.test");

    for (let i = 0; i < 30; i += 1) {
      const rejected = await pack(token, { destinationId: "nowhere" });
      expect(rejected.status).toBe(400);
    }

    const wellFormed = await pack(token, {
      destinationId: "goa",
      start: "2026-12-25",
      end: "2026-12-27",
      mode: "flight",
    });
    expect(wellFormed.status).toBe(429);
    expect(wellFormed.body.code).toBe("rate_limited");
    expect(wellFormed.headers["retry-after"]).toBeDefined();
  });

  it("charges budget before the stored key is decrypted", async () => {
    // loadUserKey runs a scrypt derivation, which is the expensive thing an
    // unauthenticated-but-registered attacker can make us do for free.
    // Exhausting the budget must therefore stop the request before the key is
    // ever loaded: a user whose key row has been deleted still gets 429 rather
    // than the 428 they would get if loadUserKey ran first.
    const token = await withKey("throttle-before-key@nomad.test");
    for (let i = 0; i < 30; i += 1) {
      await pack(token, { destinationId: "nowhere" });
    }
    await request(app)
      .delete("/api/ai/keys/anthropic")
      .set("Authorization", `Bearer ${token}`);

    const after = await pack(token, { destinationId: "nowhere" });
    expect(after.status, "428 here means loadUserKey ran before the limiter").toBe(
      429,
    );
  });
});
