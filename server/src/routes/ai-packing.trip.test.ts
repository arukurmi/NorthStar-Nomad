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
