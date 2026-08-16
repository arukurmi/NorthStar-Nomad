import { describe, it, expect, afterEach, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { cacheKey } from "../ai/cache.js";
import { MODE_CATEGORY_TITLE, type PackingList } from "../ai/packing.js";
import {
  PACKING_MAX_AGE_MS,
  PACKING_PROMPT_VERSION,
} from "../ai/prompts/packing.js";
import { FAKE_MODEL, type FakeCall, type FakeProvider } from "../ai/providers/fake.js";
import { resetProviders, useFakeProviders } from "../ai/registry.js";
import { __resetSaveLimitForTests } from "./ai-keys.js";
import { __resetPackingLimitForTests } from "./ai-packing.js";
import type { TravelMode } from "../types.js";

const app = createApp();

const ANTHROPIC_KEY = "sk-ant-api03-cache-fixture-0123456789abcd";
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_DAYS = PACKING_MAX_AGE_MS / DAY_MS;
const ZONED = /Z$|[+-]\d{2}:\d{2}$/;

/**
 * Stands in for model output. The two extra properties are deliberate: vendors
 * add fields, and `trip_packing` has a `checked` column that a later change
 * could plausibly try to round-trip through the model. `parsePackingList`
 * projects named fields into a freshly built object, so neither may survive
 * into a row that every user of this deployment will be served.
 */
interface RawItem {
  label: string;
  qty: number;
  reason?: string;
  checked?: boolean;
  sortOrder?: number;
}
interface RawCategory {
  name: string;
  items: RawItem[];
  expanded?: boolean;
}
interface RawList {
  summary: string;
  categories: RawCategory[];
}

function items(prefix: string): RawItem[] {
  return [
    { label: `${prefix} one`, qty: 3, reason: "The nights run cold up there." },
    { label: `${prefix} two`, qty: 1, reason: "", checked: true, sortOrder: 2 },
    { label: `${prefix} three`, qty: 2 },
  ];
}

function modelPayload(mode: TravelMode): RawList {
  return {
    summary: "Late monsoon on the coast: assume everything gets soaked once.",
    categories: [
      { name: "Clothing", items: items("Clothing"), expanded: true },
      { name: "Gear", items: items("Gear") },
      { name: "Documents", items: items("Documents") },
      { name: MODE_CATEGORY_TITLE[mode], items: items("Mode") },
    ],
  };
}

/**
 * The row key for a request, derived exactly as the route derives it. Every
 * ageing helper below asserts it matched a row, so a drift between this and the
 * route surfaces as a failure rather than as a test that quietly does nothing.
 */
function packingKey(
  destinationId: string,
  start: string,
  end: string,
  mode: TravelMode,
): string {
  return cacheKey({
    feature: "packing",
    destinationId,
    start,
    end,
    mode,
    model: FAKE_MODEL,
    provider: "anthropic",
    options: { pv: PACKING_PROMPT_VERSION },
  });
}

function ageRow(key: string, days: number): void {
  const changes = db
    .prepare("UPDATE ai_cache SET created_at = datetime('now', ?) WHERE cache_key = ?")
    .run(`-${days} days`, key).changes;
  expect(changes, "no cache row matched the derived key").toBe(1);
}

function rowFor(key: string): { payload: string; created_at: string } | undefined {
  return db
    .prepare("SELECT payload, created_at FROM ai_cache WHERE cache_key = ?")
    .get(key) as { payload: string; created_at: string } | undefined;
}

function packingPayloads(): string[] {
  return (
    db
      .prepare("SELECT payload FROM ai_cache WHERE feature = 'packing'")
      .all() as Array<{ payload: string }>
  ).map((row) => row.payload);
}

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Cache Nomad", email, password: "wanderlust1" });
  return res.body.token as string;
}

function userIdFor(email: string): number {
  return (
    db.prepare("SELECT id FROM users WHERE email = ?").get(email) as {
      id: number;
    }
  ).id;
}

async function withKey(email: string): Promise<string> {
  const token = await register(email);
  const saved = await request(app)
    .post("/api/ai/keys")
    .set("Authorization", `Bearer ${token}`)
    .send({ provider: "anthropic", apiKey: ANTHROPIC_KEY });
  expect(saved.status).toBe(200);
  return token;
}

function pack(token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/ai/packing")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

/**
 * Completion calls only. `fake.calls[0]` is the *validate* from saving the key,
 * which carries no prompt at all — asserting on it would pass for free.
 */
function completeCalls(fake: FakeProvider): FakeCall[] {
  return fake.calls.filter((call) => call.kind === "complete");
}

function categoryNames(body: unknown): string[] {
  return (body as { packing: PackingList }).packing.categories.map((c) => c.name);
}

afterEach(() => {
  resetProviders();
  __resetSaveLimitForTests();
  __resetPackingLimitForTests();
});

describe("POST /api/ai/packing cache", () => {
  it("pays once and serves the identical list from the row afterwards", async () => {
    // One scripted completion and no default payload: a second provider call
    // would be handed `{}`, fail the parser and 502, so "exactly one call" is
    // enforced by the fixture as well as asserted.
    const fakes = useFakeProviders({ completions: [modelPayload("flight")] });
    const token = await withKey("cache-hit@nomad.test");
    const body = {
      destinationId: "goa",
      start: "2027-01-04",
      end: "2027-01-08",
      mode: "flight",
    };

    const miss = await pack(token, body);
    expect(miss.status).toBe(200);
    expect(miss.body.cached).toBe(false);

    const hit = await pack(token, body);
    expect(hit.status).toBe(200);
    expect(hit.body.cached).toBe(true);
    expect(hit.body.packing).toEqual(miss.body.packing);
    expect(completeCalls(fakes.anthropic)).toHaveLength(1);
  });

  it("reports the stored row's age on a hit rather than the moment of the read", async () => {
    useFakeProviders({ completions: [modelPayload("flight")] });
    const token = await withKey("cache-age@nomad.test");
    const body = {
      destinationId: "goa",
      start: "2027-01-11",
      end: "2027-01-15",
      mode: "flight",
    };

    expect((await pack(token, body)).status).toBe(200);
    ageRow(packingKey("goa", body.start, body.end, "flight"), 3);

    const hit = await pack(token, body);
    expect(hit.body.cached).toBe(true);
    expect(hit.body.generatedAt).toMatch(ZONED);
    // "Generated three days ago", not "generated just now": the timestamp is the
    // user's only signal that they are reading something the cache remembered.
    const age = Date.now() - Date.parse(hit.body.generatedAt);
    expect(age).toBeGreaterThan(3 * DAY_MS - 60_000);
    expect(age).toBeLessThan(3 * DAY_MS + 60_000);
  });

  it("regenerates once the row is past the TTL", async () => {
    const fakes = useFakeProviders({
      completions: [modelPayload("flight"), modelPayload("flight")],
    });
    const token = await withKey("cache-ttl@nomad.test");
    const body = {
      destinationId: "goa",
      start: "2027-01-18",
      end: "2027-01-22",
      mode: "flight",
    };

    expect((await pack(token, body)).status).toBe(200);
    // One day past the window. Expiry is not about decay — a packing list is a
    // function of static catalogue data — it is so a catalogue correction
    // eventually reaches users and one bad generation is not permanent.
    ageRow(packingKey("goa", body.start, body.end, "flight"), TTL_DAYS + 1);

    const fresh = await pack(token, body);
    expect(fresh.status).toBe(200);
    expect(fresh.body.cached).toBe(false);
    expect(completeCalls(fakes.anthropic)).toHaveLength(2);
  });

  it("keys on the travel mode, so a rider is never served a flight list", async () => {
    const fakes = useFakeProviders({
      completions: [modelPayload("bike"), modelPayload("flight")],
    });
    const token = await withKey("cache-mode-key@nomad.test");
    const trip = { destinationId: "spiti", start: "2027-04-05", end: "2027-04-11" };

    const bike = await pack(token, { ...trip, mode: "bike" });
    const flight = await pack(token, { ...trip, mode: "flight" });

    expect(bike.body.cached).toBe(false);
    expect(flight.body.cached).toBe(false);
    expect(completeCalls(fakes.anthropic)).toHaveLength(2);

    // Two distinct rows, and the lists genuinely differ — this is the failure
    // the mode belongs in the key to prevent.
    expect(rowFor(packingKey("spiti", trip.start, trip.end, "bike"))).toBeDefined();
    expect(rowFor(packingKey("spiti", trip.start, trip.end, "flight"))).toBeDefined();
    expect(categoryNames(bike.body)).toContain(MODE_CATEGORY_TITLE.bike);
    expect(categoryNames(flight.body)).toContain(MODE_CATEGORY_TITLE.flight);
    expect(categoryNames(bike.body)).not.toEqual(categoryNames(flight.body));
  });

  it("keys on the dates, so a different month is a different list", async () => {
    const fakes = useFakeProviders({
      completions: [modelPayload("bus"), modelPayload("bus")],
    });
    const token = await withKey("cache-date-key@nomad.test");
    const trip = { destinationId: "manali", mode: "bus" };

    // January and July at the same place are not the same packing problem.
    const winter = await pack(token, { ...trip, start: "2027-01-05", end: "2027-01-09" });
    const summer = await pack(token, { ...trip, start: "2027-07-05", end: "2027-07-09" });

    expect(winter.body.cached).toBe(false);
    expect(summer.body.cached).toBe(false);
    expect(completeCalls(fakes.anthropic)).toHaveLength(2);
    expect(rowFor(packingKey("manali", "2027-01-05", "2027-01-09", "bus"))).toBeDefined();
    expect(rowFor(packingKey("manali", "2027-07-05", "2027-07-09", "bus"))).toBeDefined();
  });

  it("serves one user's answer to another, so the same question is paid for once", async () => {
    const fakes = useFakeProviders({ completions: [modelPayload("flight")] });
    const alice = await withKey("cache-alice@nomad.test");
    const bob = await withKey("cache-bob@nomad.test");
    const body = {
      destinationId: "jaipur",
      start: "2027-02-01",
      end: "2027-02-05",
      mode: "flight",
    };

    const paid = await pack(alice, body);
    expect(paid.status).toBe(200);
    expect(paid.body.cached).toBe(false);

    const free = await pack(bob, body);
    expect(free.status).toBe(200);
    expect(free.body.cached).toBe(true);
    expect(free.body.packing).toEqual(paid.body.packing);
    // The global cache proven end to end: `ai_cache` has no owner column and
    // `cacheKey` has no user field, so two strangers asking the same trip
    // question share one completion. Bob's key was never touched.
    expect(completeCalls(fakes.anthropic)).toHaveLength(1);
  });

  it("records a billed row for the miss and a zero-token row for the hit", async () => {
    useFakeProviders({ completions: [modelPayload("flight")] });
    const email = "cache-usage@nomad.test";
    const token = await withKey(email);
    const body = {
      destinationId: "udaipur",
      start: "2027-03-01",
      end: "2027-03-05",
      mode: "flight",
    };

    expect((await pack(token, body)).status).toBe(200);
    expect((await pack(token, body)).body.cached).toBe(true);

    const rows = db
      .prepare(
        `SELECT cached, input_tokens AS inputTokens, output_tokens AS outputTokens
           FROM ai_usage WHERE user_id = ? AND feature = 'packing' ORDER BY id`,
      )
      .all(userIdFor(email)) as Array<{
      cached: number;
      inputTokens: number;
      outputTokens: number;
    }>;

    // A hit is still a row. That is what makes the saving visible: `calls`
    // counts what the user asked for, `cachedCalls` how much of it was free.
    expect(rows).toHaveLength(2);
    expect(rows[0].cached).toBe(0);
    expect(rows[0].inputTokens).toBeGreaterThan(0);
    expect(rows[0].outputTokens).toBeGreaterThan(0);
    expect(rows[1].cached).toBe(1);
    expect(rows[1].inputTokens).toBe(0);
    expect(rows[1].outputTokens).toBe(0);
  });

  it("treats a row it can no longer parse as a miss and reheals it", async () => {
    const fakes = useFakeProviders({
      completions: [modelPayload("flight"), modelPayload("flight")],
    });
    const token = await withKey("cache-poisoned@nomad.test");
    const body = {
      destinationId: "coorg",
      start: "2027-05-03",
      end: "2027-05-07",
      mode: "flight",
    };

    const first = await pack(token, body);
    expect(first.status).toBe(200);

    // `ai_cache` is global and this row was written by whoever happened to
    // trigger the miss. A payload from a prompt version this build no longer
    // understands — or one edited straight into the SQLite file — must not be
    // served with our UI's trust, checkboxes and item keys and all.
    const key = packingKey("coorg", body.start, body.end, "flight");
    const poisoned = db
      .prepare("UPDATE ai_cache SET payload = ? WHERE cache_key = ?")
      .run('{"summary":"poisoned","categories":[]}', key).changes;
    expect(poisoned).toBe(1);

    const healed = await pack(token, body);
    // A miss, not a 502: the user gets a correct list rather than an error page.
    expect(healed.status).toBe(200);
    expect(healed.body.cached).toBe(false);
    expect(healed.body.packing).toEqual(first.body.packing);
    expect(completeCalls(fakes.anthropic)).toHaveLength(2);
    expect(JSON.parse(rowFor(key)!.payload)).toEqual(first.body.packing);
  });
});

/**
 * The rows in `ai_cache` are shared by every account on the deployment, so
 * anything user-specific that reaches one is a leak from the first hit onwards
 * — and it survives for the full TTL.
 */
describe("POST /api/ai/packing cache isolation", () => {
  it("keeps request text out of both prompts", async () => {
    const CANARY = "PROMPT-CANARY-7f3a9c2e";
    const fakes = useFakeProviders({ completions: [modelPayload("flight")] });
    const token = await withKey("cache-prompt-canary@nomad.test");

    const res = await pack(token, {
      destinationId: "goa",
      start: "2027-06-07",
      end: "2027-06-11",
      mode: "flight",
      // Fields the route does not read. `PackingGrounding` has no index
      // signature and `packingUserPrompt` interpolates its fields only, so
      // there is no path from here into a prompt that is not a compile error.
      notes: CANARY,
      travellerName: CANARY,
      email: CANARY,
    });
    expect(res.status).toBe(200);

    const call = completeCalls(fakes.anthropic)[0];
    expect(call).toBeDefined();
    expect(call.system, "the system prompt carried request text").not.toContain(CANARY);
    expect(call.user, "the user prompt carried request text").not.toContain(CANARY);
  });

  it("keeps request text out of every stored payload", async () => {
    const CANARY = "CACHE-CANARY-2b5d1e04";
    useFakeProviders({ completions: [modelPayload("bus")] });
    const token = await withKey("cache-payload-canary@nomad.test");

    const res = await pack(token, {
      destinationId: "manali",
      start: "2027-06-14",
      end: "2027-06-18",
      mode: "bus",
      notes: CANARY,
      travellerName: CANARY,
    });
    expect(res.status).toBe(200);

    const payloads = packingPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) expect(payload).not.toContain(CANARY);
  });

  it("stores no per-user checkbox state", async () => {
    // The scripted payload carries `checked` on an item and `expanded` on a
    // category. `checked` is per *trip*, in `trip_packing`; cached globally it
    // would show a stranger's ticks.
    useFakeProviders({ completions: [modelPayload("flight")] });
    const token = await withKey("cache-no-checked@nomad.test");

    const res = await pack(token, {
      destinationId: "jaisalmer",
      start: "2027-06-21",
      end: "2027-06-25",
      mode: "flight",
    });
    expect(res.status).toBe(200);

    const payloads = packingPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain('"checked"');
      expect(payload).not.toContain('"expanded"');
      expect(payload).not.toContain('"sortOrder"');
    }
  });

  it("stores no user identifier", async () => {
    useFakeProviders({ completions: [modelPayload("flight")] });
    const email = "cache-anonymous@nomad.test";
    const token = await withKey(email);

    const res = await pack(token, {
      destinationId: "agra",
      start: "2027-06-28",
      end: "2027-07-02",
      mode: "flight",
    });
    expect(res.status).toBe(200);

    /**
     * Every numeric leaf in the payload, labelled with the property it sits
     * under. Asserted structurally rather than by searching the payload for the
     * user's id: a bare integer like `7` occurs by coincidence in `qty`, so a
     * substring check on one would pass or fail for the wrong reason. If a user
     * id, a trip id or a timestamp ever reaches a row, a numeric leaf appears
     * under a name that is not `qty` and this fails without being edited.
     */
    function numericLeaves(value: unknown, key: string): string[] {
      if (typeof value === "number") return [key];
      if (Array.isArray(value)) {
        return value.flatMap((entry) => numericLeaves(entry, key));
      }
      if (value !== null && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>).flatMap(
          ([name, entry]) => numericLeaves(entry, name),
        );
      }
      return [];
    }

    const payloads = packingPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      const leaves = numericLeaves(JSON.parse(payload), "(root)");
      expect(leaves.length).toBeGreaterThan(0);
      expect([...new Set(leaves)].sort()).toEqual(["qty"]);
      expect(payload).not.toContain(email);
      expect(payload).not.toContain("nomad.test");
    }
  });
});

describe("POST /api/ai/packing mode brief", () => {
  it("grounds a bike list in panniers and a flight list in the cabin", async () => {
    const fakes = useFakeProviders({
      completions: [modelPayload("bike"), modelPayload("flight")],
    });
    const token = await withKey("cache-mode-brief@nomad.test");
    const trip = { destinationId: "ladakh", start: "2027-08-02", end: "2027-08-08" };

    expect((await pack(token, { ...trip, mode: "bike" })).status).toBe(200);
    expect((await pack(token, { ...trip, mode: "flight" })).status).toBe(200);

    const [bike, flight] = completeCalls(fakes.anthropic);
    // Each brief is written in its own mode's vocabulary. The exclusivity is
    // the assertion that bites the day someone folds the two into one template
    // with the mode word swapped in.
    expect(bike.user).toMatch(/pannier/i);
    expect(bike.user).not.toMatch(/cabin/i);
    expect(flight.user).toMatch(/cabin/i);
    expect(flight.user).not.toMatch(/pannier/i);
  });
});

describe("the route's own cache-key wiring", () => {
  // Exact row counts, and earlier tests in this file share the database, so
  // this block starts from a clean packing table.
  beforeEach(() => {
    db.prepare("DELETE FROM ai_cache WHERE feature = 'packing'").run();
  });

  const OPENAI_KEY = "sk-cache-fixture-openai-0123456789abcd";
  const TUPLE = {
    destinationId: "goa",
    start: "2026-12-25",
    end: "2026-12-27",
    mode: "flight" as const,
  };

  async function withOpenAiKey(email: string): Promise<string> {
    const token = await register(email);
    const saved = await request(app)
      .post("/api/ai/keys")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "openai", apiKey: OPENAI_KEY });
    expect(saved.status).toBe(200);
    return token;
  }

  it("namespaces by provider, so one vendor's answer is not served for another", async () => {
    // cache.test.ts proves cacheKey separates providers. This proves the ROUTE
    // actually passes the caller's provider into it — hardcoding
    // `provider: "anthropic"` at the call site would leave that suite green
    // while reintroducing the exact cross-vendor serving the field exists to
    // stop. Same tuple, same model id, two vendors, two completions.
    const fakes = useFakeProviders({ defaultPayload: modelPayload("flight") });
    const anthropicUser = await withKey("ns-anthropic@nomad.test");
    const openAiUser = await withOpenAiKey("ns-openai@nomad.test");

    const first = await pack(anthropicUser, TUPLE);
    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);

    const second = await pack(openAiUser, TUPLE);
    expect(second.status).toBe(200);
    expect(second.body.cached, "an OpenAI user was served an Anthropic row").toBe(
      false,
    );

    const completions = (id: "anthropic" | "openai") =>
      (fakes[id] as FakeProvider).calls.filter(
        (c: FakeCall) => c.kind === "complete",
      ).length;
    expect(completions("anthropic")).toBe(1);
    expect(completions("openai")).toBe(1);

    // Two rows, not one, and both are real.
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM ai_cache WHERE feature = 'packing'")
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("namespaces by model, so changing a model does not serve the old answer", async () => {
    // The model travels from the user's own ai_keys row, so this is the path a
    // user takes when they switch model and expect a fresh answer.
    const fakes = useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("ns-model@nomad.test");

    expect((await pack(token, TUPLE)).body.cached).toBe(false);

    const changed = db
      .prepare("UPDATE ai_keys SET model = ? WHERE user_id = ?")
      .run("claude-opus-9", userIdFor("ns-model@nomad.test")).changes;
    expect(changed).toBe(1);

    const second = await pack(token, TUPLE);
    expect(second.status).toBe(200);
    expect(second.body.cached, "a new model was served the old model's row").toBe(
      false,
    );
    expect(
      (fakes.anthropic as FakeProvider).calls.filter(
        (c: FakeCall) => c.kind === "complete",
      ),
    ).toHaveLength(2);
  });
});

describe("concurrent identical misses", () => {
  // Exact completion counts, and the first test in this block caches the very
  // tuple the second one reuses.
  beforeEach(() => {
    db.prepare("DELETE FROM ai_cache WHERE feature = 'packing'").run();
  });

  it("buys one answer when two users ask at the same moment", async () => {
    // The cache row is only written after a completion returns, so before
    // single-flight both of these missed, both called the vendor, and both
    // paid — for one answer, of which one was immediately overwritten. The
    // window is the vendor's latency, which is the longest part of a request.
    const fakes = useFakeProviders({
      defaultPayload: modelPayload("flight"),
      // Latency is what makes this a race at all; with an instant fake the
      // first call would settle before the second was issued and the test
      // would pass without exercising anything.
      latencyMs: 40,
    });
    const alice = await withKey("inflight-alice@nomad.test");
    const bob = await withKey("inflight-bob@nomad.test");
    const tuple = {
      destinationId: "goa",
      start: "2026-11-20",
      end: "2026-11-22",
      mode: "flight" as const,
    };

    const [first, second] = await Promise.all([
      pack(alice, tuple),
      pack(bob, tuple),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.packing).toEqual(second.body.packing);

    const completions = (fakes.anthropic as FakeProvider).calls.filter(
      (c: FakeCall) => c.kind === "complete",
    );
    expect(completions, "two users, one paid call").toHaveLength(1);
  });

  it("still bills both when the two questions differ", async () => {
    // The guard must key on the question, not merely on concurrency.
    const fakes = useFakeProviders({
      defaultPayload: modelPayload("flight"),
      latencyMs: 40,
    });
    const token = await withKey("inflight-distinct@nomad.test");
    await Promise.all([
      pack(token, {
        destinationId: "goa",
        start: "2026-11-20",
        end: "2026-11-22",
        mode: "flight",
      }),
      pack(token, {
        destinationId: "goa",
        start: "2026-11-27",
        end: "2026-11-29",
        mode: "flight",
      }),
    ]);
    expect(
      (fakes.anthropic as FakeProvider).calls.filter(
        (c: FakeCall) => c.kind === "complete",
      ),
    ).toHaveLength(2);
  });
});
