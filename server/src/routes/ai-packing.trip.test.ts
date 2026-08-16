import { describe, it, expect, afterEach, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { MODE_CATEGORY_TITLE } from "../ai/packing.js";
import { resetProviders, useFakeProviders } from "../ai/registry.js";
import type { FakeCall, FakeProvider } from "../ai/providers/fake.js";
import { __resetSaveLimitForTests } from "./ai-keys.js";
import { __resetPackingLimitForTests } from "./ai-packing.js";
import type { TravelMode } from "../types.js";

const app = createApp();
const ANTHROPIC_KEY = "sk-ant-api03-trip-fixture-0123456789abcd";

/** Stands in for model output. Four categories, three items each. */
function modelPayload(mode: TravelMode, drop = false) {
  const items = (prefix: string) =>
    [1, 2, 3].map((n) => ({
      label: `${prefix} item ${n}`,
      qty: n,
      reason: "",
    }));
  const mine = items("Mode");
  return {
    summary: "A short trip with predictable weather.",
    categories: [
      { name: "Clothing", items: items("Clothing") },
      { name: "Gear", items: items("Gear") },
      { name: "Documents", items: items("Documents") },
      {
        name: MODE_CATEGORY_TITLE[mode],
        // `drop` removes nothing (3 is the parser's minimum) but renames one
        // item, so a regeneration produces a genuinely different key set.
        items: drop
          ? [...mine.slice(0, 2), { label: "Replacement item", qty: 1, reason: "" }]
          : mine,
      },
    ],
  };
}

const ITEM_COUNT = 12;

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Trip Nomad", email, password: "wanderlust1" });
  return res.body.token as string;
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

async function saveTrip(
  token: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body.trip.id as number;
}

function pack(token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/ai/packing")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function completions(fake: FakeProvider): number {
  return fake.calls.filter((c: FakeCall) => c.kind === "complete").length;
}

function rowsFor(tripId: number): Array<{ item_key: string; sort_order: number; checked: number }> {
  return db
    .prepare(
      "SELECT item_key, sort_order, checked FROM trip_packing WHERE trip_id = ? ORDER BY sort_order",
    )
    .all(tripId) as Array<{ item_key: string; sort_order: number; checked: number }>;
}

beforeEach(() => {
  db.prepare("DELETE FROM ai_cache WHERE feature = 'packing'").run();
});

afterEach(() => {
  resetProviders();
  __resetSaveLimitForTests();
  __resetPackingLimitForTests();
});

const SPITI = {
  destinationId: "spiti",
  start: "2026-06-12",
  end: "2026-06-18",
  mode: "bike" as const,
};

describe("trip state on the packing response", () => {
  it("includes trip when a saved trip matches the tuple exactly", async () => {
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-match@nomad.test");
    const tripId = await saveTrip(token, SPITI);

    const res = await pack(token, SPITI);
    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(tripId);
    expect(res.body.trip.total).toBe(ITEM_COUNT);
    expect(res.body.trip.checkedCount).toBe(0);
    expect(Object.keys(res.body.trip.checked)).toHaveLength(ITEM_COUNT);
    // Every key in the tick map is a key the payload actually carries, so the
    // client can index one by the other without a lookup miss.
    const payloadKeys = res.body.packing.categories.flatMap(
      (c: { items: Array<{ itemKey: string }> }) => c.items.map((i) => i.itemKey),
    );
    expect(Object.keys(res.body.trip.checked).sort()).toEqual(payloadKeys.sort());
  });

  it("omits trip entirely when no trip is saved for those dates", async () => {
    // Generating for dates the user has not saved is legitimate — the absent
    // field is what tells the client to render the checkboxes disabled.
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-none@nomad.test");

    const res = await pack(token, SPITI);
    expect(res.status).toBe(200);
    expect("trip" in res.body).toBe(false);
  });

  it("omits trip when the saved trip is for a different mode", async () => {
    // A bike list and a flight list are different lists, so a bike trip must
    // not collect the ticks for a flight one.
    useFakeProviders({ defaultPayload: modelPayload("flight") });
    const token = await withKey("trip-mode@nomad.test");
    await saveTrip(token, SPITI);

    const res = await pack(token, { ...SPITI, mode: "flight" });
    expect(res.status).toBe(200);
    expect("trip" in res.body).toBe(false);
  });

  it("writes one trip_packing row per item, ordered across categories", async () => {
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-rows@nomad.test");
    const tripId = await saveTrip(token, SPITI);
    await pack(token, SPITI);

    const rows = rowsFor(tripId);
    expect(rows).toHaveLength(ITEM_COUNT);
    // sort_order is the flattened index across the whole list, which is what
    // lets the profile card render in the model's order with nothing re-derived.
    expect(rows.map((r) => r.sort_order)).toEqual(
      Array.from({ length: ITEM_COUNT }, (_, i) => i),
    );
  });
});

describe("syncing on the cache-hit path", () => {
  it("syncs a trip saved after the list was generated, without paying twice", async () => {
    // The case that would otherwise be missed entirely. A user generates a
    // list, likes it, and only then saves the trip. If the sync ran on the
    // miss path alone, their checkboxes would never appear — and the only way
    // to make them appear would be to bust the cache and buy the same answer
    // a second time.
    const fakes = useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-late-save@nomad.test");

    const first = await pack(token, SPITI);
    expect(first.body.cached).toBe(false);
    expect("trip" in first.body).toBe(false);

    const tripId = await saveTrip(token, SPITI);

    const second = await pack(token, SPITI);
    expect(second.status).toBe(200);
    expect(second.body.cached, "the answer should still be free").toBe(true);
    expect(second.body.trip.id).toBe(tripId);
    expect(second.body.trip.total).toBe(ITEM_COUNT);
    expect(rowsFor(tripId)).toHaveLength(ITEM_COUNT);
    expect(completions(fakes.anthropic as FakeProvider)).toBe(1);
  });

  it("keeps ticks when a cache hit re-syncs the same list", async () => {
    const fakes = useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-hit-ticks@nomad.test");
    const tripId = await saveTrip(token, SPITI);

    const first = await pack(token, SPITI);
    const [firstKey] = Object.keys(first.body.trip.checked);
    const ticked = await request(app)
      .post(`/api/trips/${tripId}/packing/check`)
      .set("Authorization", `Bearer ${token}`)
      .send({ itemKey: firstKey, checked: true });
    expect(ticked.status).toBe(200);

    const second = await pack(token, SPITI);
    expect(second.body.cached).toBe(true);
    expect(second.body.trip.checked[firstKey]).toBe(true);
    expect(second.body.trip.checkedCount).toBe(1);
    expect(completions(fakes.anthropic as FakeProvider)).toBe(1);
  });
});

describe("regeneration", () => {
  it("preserves ticks on surviving items and prunes the rest", async () => {
    const token = await withKey("trip-regen@nomad.test");
    const tripId = await saveTrip(token, SPITI);

    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const first = await pack(token, SPITI);
    const keys = Object.keys(first.body.trip.checked);
    // Tick one item that survives the regeneration and one that does not.
    const survivor = first.body.packing.categories[0].items[0].itemKey;
    const doomed = first.body.packing.categories[3].items[2].itemKey;
    for (const itemKey of [survivor, doomed]) {
      const res = await request(app)
        .post(`/api/trips/${tripId}/packing/check`)
        .set("Authorization", `Bearer ${token}`)
        .send({ itemKey, checked: true });
      expect(res.status).toBe(200);
    }
    expect(rowsFor(tripId).filter((r) => r.checked === 1)).toHaveLength(2);

    // Force a genuine regeneration rather than a hit: age the row past the TTL
    // and script a list where the last mode item has been replaced.
    db.prepare(
      "UPDATE ai_cache SET created_at = datetime('now', '-31 days') WHERE feature = 'packing'",
    ).run();
    useFakeProviders({ defaultPayload: modelPayload("bike", true) });

    const second = await pack(token, SPITI);
    expect(second.body.cached).toBe(false);

    const after = rowsFor(tripId);
    expect(after, "total must stay exact after a prune").toHaveLength(ITEM_COUNT);
    // The survivor keeps its tick; the dropped item's row is gone entirely.
    expect(after.find((r) => r.item_key === survivor)?.checked).toBe(1);
    expect(after.find((r) => r.item_key === doomed)).toBeUndefined();
    expect(second.body.trip.checkedCount).toBe(1);
    expect(keys).toHaveLength(ITEM_COUNT);
  });
});

describe("tripId is never an authorisation token", () => {
  it("rejects another user's trip id without reaching the provider", async () => {
    const fakes = useFakeProviders({ defaultPayload: modelPayload("bike") });
    const victim = await withKey("trip-victim@nomad.test");
    const victimTrip = await saveTrip(victim, SPITI);
    const attacker = await withKey("trip-attacker@nomad.test");

    const res = await pack(attacker, { ...SPITI, tripId: victimTrip });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
    // Nothing was generated and, more importantly, nothing was written to the
    // victim's trip: a 400 that still synced would be a cross-user write.
    expect(completions(fakes.anthropic as FakeProvider)).toBe(0);
    expect(rowsFor(victimTrip)).toHaveLength(0);
  });

  it("gives the same message for a foreign id as for a malformed one", async () => {
    // No existence oracle: an attacker must not be able to distinguish "that
    // trip is not yours" from "that is not a trip id" by reading the response.
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const owner = await withKey("trip-oracle-owner@nomad.test");
    const ownedTrip = await saveTrip(owner, SPITI);
    const other = await withKey("trip-oracle-other@nomad.test");

    const foreign = await pack(other, { ...SPITI, tripId: ownedTrip });
    const malformed = await pack(other, { ...SPITI, tripId: 0 });
    const absent = await pack(other, { ...SPITI, tripId: 9_999_999 });
    expect(foreign.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(absent.status).toBe(400);
    expect(foreign.body.error).toBe(malformed.body.error);
    expect(foreign.body.error).toBe(absent.body.error);
  });

  it("rejects the caller's own trip id when it does not match the tuple", async () => {
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-mismatch@nomad.test");
    // A real trip of theirs, but for different dates than the request names.
    const otherTrip = await saveTrip(token, {
      ...SPITI,
      start: "2026-09-01",
      end: "2026-09-04",
    });

    const res = await pack(token, { ...SPITI, tripId: otherTrip });
    expect(res.status).toBe(400);
    expect(rowsFor(otherTrip)).toHaveLength(0);
  });

  it("accepts the caller's own matching trip id", async () => {
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-ok@nomad.test");
    const tripId = await saveTrip(token, SPITI);

    const res = await pack(token, { ...SPITI, tripId });
    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(tripId);
  });
});

describe("tick state never reaches the shared cache", () => {
  it("stores no checked flag in any packing cache payload", async () => {
    // ai_cache is global. A checked flag in a stored payload would be one
    // user's private state served verbatim to a stranger, so the guarantee is
    // structural: PackingList has no such field and the tick state is
    // assembled after putCached.
    useFakeProviders({ defaultPayload: modelPayload("bike") });
    const token = await withKey("trip-cache-purity@nomad.test");
    const tripId = await saveTrip(token, SPITI);

    const res = await pack(token, SPITI);
    const [firstKey] = Object.keys(res.body.trip.checked);
    await request(app)
      .post(`/api/trips/${tripId}/packing/check`)
      .set("Authorization", `Bearer ${token}`)
      .send({ itemKey: firstKey, checked: true });

    const payloads = (
      db
        .prepare("SELECT payload FROM ai_cache WHERE feature = 'packing'")
        .all() as Array<{ payload: string }>
    ).map((r) => r.payload);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain("checked");
      expect(payload).not.toContain("checkedCount");
      // Not a bare "trip" search — the model's own summary prose legitimately
      // contains the word. What must never appear is the tick envelope.
      expect(payload).not.toContain('"trip"');
    }
  });
});
