import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { MODE_CATEGORY_TITLE, parsePackingList } from "../ai/packing.js";
import { syncTripPacking } from "../ai/packingStore.js";
import { resetProviders } from "../ai/registry.js";
import { __resetSaveLimitForTests } from "./ai-keys.js";
import { __resetPackingLimitForTests } from "./ai-packing.js";
import type { TravelMode } from "../types.js";

const app = createApp();

/**
 * Not one `POST /api/ai/keys` in this file, and that is load-bearing rather than
 * incidental: everything below is reachable with no provider, no key and no
 * cache row. The AI route is what *fills* `trip_packing`; the trip routes only
 * ever read and tick it.
 */

/** 16 lowercase hex characters — the one shape a tick endpoint accepts. */
const ITEM_KEY = /^[0-9a-f]{16}$/;

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
 * Four categories of three items, one carrying the heading the prompt dictates
 * for `mode`. Rebuilt per call so a mutation in one test cannot reach another.
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

/**
 * Seeds `trip_packing` exactly as the AI route does — through the real parser,
 * so the stored `item_key`s are the real digests a client would echo back — and
 * returns the flattened keys in `sort_order`.
 */
function seedPacking(tripId: number, mode: TravelMode): string[] {
  const list = parsePackingList(modelPayload(mode), mode);
  (() => {
    const owner = db
      .prepare("SELECT user_id AS userId FROM trips WHERE id = ?")
      .get(tripId) as { userId: number };
    syncTripPacking(tripId, owner.userId, list);
  })();
  return list.categories.flatMap((c) => c.items.map((i) => i.itemKey));
}

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Trips Nomad", email, password: "wanderlust1" });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

function createTrip(token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

/** Creates a trip and hands back its id, failing loudly if creation did not. */
async function tripFor(
  token: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await createTrip(token, body);
  expect(res.status).toBe(201);
  return res.body.trip.id as number;
}

function getPacking(token: string, id: number | string) {
  return request(app)
    .get(`/api/trips/${id}/packing`)
    .set("Authorization", `Bearer ${token}`);
}

function check(
  token: string,
  id: number | string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post(`/api/trips/${id}/packing/check`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function packingRowCount(tripId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM trip_packing WHERE trip_id = ?")
      .get(tripId) as { n: number }
  ).n;
}

function checkedFlag(tripId: number, itemKey: string): number | undefined {
  return (
    db
      .prepare(
        "SELECT checked FROM trip_packing WHERE trip_id = ? AND item_key = ?",
      )
      .get(tripId, itemKey) as { checked: number } | undefined
  )?.checked;
}

interface StoredCategory {
  name: string;
  modeCategory: boolean;
  items: Array<{ itemKey: string; label: string; qty: number; checked: boolean }>;
}

function categoriesOf(body: unknown): StoredCategory[] {
  return (body as { categories: StoredCategory[] }).categories;
}

afterEach(() => {
  resetProviders();
  __resetSaveLimitForTests();
  __resetPackingLimitForTests();
});

describe("POST /api/trips", () => {
  it("creates a trip and returns it", async () => {
    const token = await register("trip-create@nomad.test");
    const res = await createTrip(token, {
      destinationId: "goa",
      start: "2027-01-04",
      end: "2027-01-08",
      mode: "flight",
    });

    expect(res.status).toBe(201);
    expect(res.body.trip).toMatchObject({
      destination_id: "goa",
      destination_name: "Goa",
      start: "2027-01-04",
      end: "2027-01-08",
      mode: "flight",
      status: "planned",
    });
    expect(res.body.trip.id).toBeGreaterThan(0);
  });

  it("409s on a second trip with the same destination and start", async () => {
    const token = await register("trip-duplicate@nomad.test");
    const body = {
      destinationId: "manali",
      start: "2027-02-01",
      end: "2027-02-05",
    };
    expect((await createTrip(token, body)).status).toBe(201);

    // The end date differs; the duplicate check is (user, destination, start).
    const again = await createTrip(token, { ...body, end: "2027-02-09" });
    expect(again.status).toBe(409);
  });

  it("400s on a destination that is not in the catalogue", async () => {
    const token = await register("trip-bad-dest@nomad.test");
    const res = await createTrip(token, {
      destinationId: "atlantis",
      start: "2027-03-01",
      end: "2027-03-05",
    });
    expect(res.status).toBe(400);
  });

  it("401s without a bearer token", async () => {
    const res = await request(app)
      .post("/api/trips")
      .send({ destinationId: "goa", start: "2027-04-01", end: "2027-04-05" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/trips", () => {
  it("returns only the caller's trips", async () => {
    const alice = await register("trip-list-alice@nomad.test");
    const bob = await register("trip-list-bob@nomad.test");

    await tripFor(alice, {
      destinationId: "goa",
      start: "2027-05-01",
      end: "2027-05-05",
    });
    await tripFor(bob, {
      destinationId: "jaipur",
      start: "2027-05-10",
      end: "2027-05-14",
    });

    const res = await request(app)
      .get("/api/trips")
      .set("Authorization", `Bearer ${alice}`);
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].destination_id).toBe("goa");
  });
});

describe("PATCH /api/trips/:id", () => {
  it("sets the status", async () => {
    const token = await register("trip-patch@nomad.test");
    const id = await tripFor(token, {
      destinationId: "udaipur",
      start: "2027-06-01",
      end: "2027-06-05",
    });

    const res = await request(app)
      .patch(`/api/trips/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "taken" });
    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe("taken");
  });

  it("404s on another user's trip", async () => {
    const owner = await register("trip-patch-owner@nomad.test");
    const stranger = await register("trip-patch-stranger@nomad.test");
    const id = await tripFor(owner, {
      destinationId: "coorg",
      start: "2027-06-10",
      end: "2027-06-14",
    });

    const res = await request(app)
      .patch(`/api/trips/${id}`)
      .set("Authorization", `Bearer ${stranger}`)
      .send({ status: "skipped" });
    expect(res.status).toBe(404);

    const row = db
      .prepare("SELECT status FROM trips WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("planned");
  });
});

describe("DELETE /api/trips/:id", () => {
  it("removes the trip", async () => {
    const token = await register("trip-delete@nomad.test");
    const id = await tripFor(token, {
      destinationId: "agra",
      start: "2027-07-01",
      end: "2027-07-05",
    });

    const res = await request(app)
      .delete(`/api/trips/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(db.prepare("SELECT id FROM trips WHERE id = ?").get(id)).toBeUndefined();
  });

  it("404s on another user's trip and leaves it standing", async () => {
    const owner = await register("trip-delete-owner@nomad.test");
    const stranger = await register("trip-delete-stranger@nomad.test");
    const id = await tripFor(owner, {
      destinationId: "varanasi",
      start: "2027-07-10",
      end: "2027-07-14",
    });

    const res = await request(app)
      .delete(`/api/trips/${id}`)
      .set("Authorization", `Bearer ${stranger}`);
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT id FROM trips WHERE id = ?").get(id)).toBeDefined();
  });
});

describe("GET /api/trips/:id/packing", () => {
  it("answers an empty list for an owned trip with nothing generated", async () => {
    const token = await register("packing-empty@nomad.test");
    const id = await tripFor(token, {
      destinationId: "goa",
      start: "2027-08-01",
      end: "2027-08-05",
    });

    const res = await getPacking(token, id);
    // An empty list is a correct answer here, not an error.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ categories: [], checkedCount: 0, total: 0 });
  });

  it("rehydrates the stored snapshot with no key, no provider call and no cache row", async () => {
    // This account never saved an API key — no account in this file did — and
    // nothing here touches `ai_cache`. That is the whole point of the snapshot
    // design: after a reload, or 31 days later when the cache row has expired,
    // the list and the ticks are still readable and tickable from
    // `trip_packing` alone.
    const token = await register("packing-rehydrate@nomad.test");
    const id = await tripFor(token, {
      destinationId: "spiti",
      start: "2027-08-10",
      end: "2027-08-16",
      mode: "bike",
    });
    const keys = seedPacking(id, "bike");

    const res = await getPacking(token, id);
    expect(res.status).toBe(200);

    const categories = categoriesOf(res.body);
    // Grouped and ordered by `sort_order`, which is the flattened index the
    // generator wrote — the model's intended order, nothing re-derived on read.
    expect(categories.map((c) => c.name)).toEqual([
      "Clothing",
      "Gear",
      "Documents",
      MODE_CATEGORY_TITLE.bike,
    ]);
    expect(categories.flatMap((c) => c.items.map((i) => i.itemKey))).toEqual(keys);
    expect(categories[0].items.map((i) => i.label)).toEqual([
      "Clothing one",
      "Clothing two",
      "Clothing three",
    ]);
    // Exactly one section is flagged, and it is the one matching this trip's
    // own `mode` column — derived on read, not stored.
    expect(
      categories.filter((c) => c.modeCategory).map((c) => c.name),
    ).toEqual([MODE_CATEGORY_TITLE.bike]);

    expect(res.body.total).toBe(keys.length);
    expect(res.body.checkedCount).toBe(0);
    for (const key of keys) expect(key).toMatch(ITEM_KEY);
    // `reason: ""` in the payload is dropped, never stored as an empty string.
    expect(categories[0].items[1]).not.toHaveProperty("reason");
    expect(categories[0].items[0].checked).toBe(false);
  });

  it("401s without a bearer token", async () => {
    const token = await register("packing-get-401@nomad.test");
    const id = await tripFor(token, {
      destinationId: "kasol",
      start: "2027-08-20",
      end: "2027-08-24",
    });
    expect((await request(app).get(`/api/trips/${id}/packing`)).status).toBe(401);
  });

  it("404s on another user's trip, an unknown id and a non-integer id alike", async () => {
    const owner = await register("packing-get-owner@nomad.test");
    const stranger = await register("packing-get-stranger@nomad.test");
    const id = await tripFor(owner, {
      destinationId: "ladakh",
      start: "2027-09-01",
      end: "2027-09-07",
      mode: "bike",
    });
    seedPacking(id, "bike");

    // One shape of miss, no oracle: someone else's trip, a trip that never
    // existed, and an id that could never name a row are indistinguishable.
    expect((await getPacking(stranger, id)).status).toBe(404);
    expect((await getPacking(owner, 987654)).status).toBe(404);
    expect((await getPacking(owner, "abc")).status).toBe(404);
    expect((await getPacking(owner, "abc")).body.code).toBe("not_found");
  });
});

describe("POST /api/trips/:id/packing/check", () => {
  it("404s a non-integer id, without ever reaching the store", async () => {
    // parseTripId short-circuits before setChecked, so a well-formed body with
    // a nonsense id must still land on the same 404 as a missing trip. The GET
    // side of this is covered; without this the POST side was not.
    const token = await register("check-bad-id@nomad.test");
    const res = await check(token, "abc", {
      itemKey: "0123456789abcdef",
      checked: true,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("ticks and unticks, and the change is visible through the GET", async () => {
    const token = await register("check-roundtrip@nomad.test");
    const id = await tripFor(token, {
      destinationId: "goa",
      start: "2027-09-10",
      end: "2027-09-14",
    });
    const [first] = seedPacking(id, "flight");

    const ticked = await check(token, id, { itemKey: first, checked: true });
    expect(ticked.status).toBe(200);
    expect(ticked.body).toMatchObject({
      itemKey: first,
      checked: true,
      checkedCount: 1,
      total: 12,
    });

    const afterTick = await getPacking(token, id);
    expect(afterTick.body.checkedCount).toBe(1);
    expect(categoriesOf(afterTick.body)[0].items[0].checked).toBe(true);

    const untick = await check(token, id, { itemKey: first, checked: false });
    expect(untick.status).toBe(200);
    expect(untick.body.checked).toBe(false);
    expect(untick.body.checkedCount).toBe(0);

    const afterUntick = await getPacking(token, id);
    expect(afterUntick.body.checkedCount).toBe(0);
    expect(categoriesOf(afterUntick.body)[0].items[0].checked).toBe(false);
  });

  it("recomputes the count from the rows rather than the client's arithmetic", async () => {
    const token = await register("check-counts@nomad.test");
    const id = await tripFor(token, {
      destinationId: "jaisalmer",
      start: "2027-09-20",
      end: "2027-09-24",
    });
    const keys = seedPacking(id, "flight");

    expect((await check(token, id, { itemKey: keys[0], checked: true })).body
      .checkedCount).toBe(1);
    const second = await check(token, id, { itemKey: keys[5], checked: true });
    expect(second.body.checkedCount).toBe(2);
    expect(second.body.total).toBe(keys.length);
    expect((await getPacking(token, id)).body.checkedCount).toBe(2);
  });

  it("400s on a body whose shape could never name a checkbox", async () => {
    const token = await register("check-bad-body@nomad.test");
    const id = await tripFor(token, {
      destinationId: "munnar",
      start: "2027-10-01",
      end: "2027-10-05",
    });
    const [first] = seedPacking(id, "flight");

    const cases: Array<[string, Record<string, unknown>]> = [
      ["a non-boolean checked", { itemKey: first, checked: "true" }],
      ["a non-string itemKey", { itemKey: 12345678, checked: true }],
      ["a short word", { itemKey: "nope", checked: true }],
      ["a full 64-hex digest", { itemKey: "a".repeat(64), checked: true }],
      ["an uppercase key", { itemKey: first.toUpperCase(), checked: true }],
    ];
    for (const [label, body] of cases) {
      const res = await check(token, id, body);
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe("bad_request");
    }
    // None of them moved a row.
    expect(checkedFlag(id, first)).toBe(0);
  });

  it("404s on a well-shaped key that is not on this trip's list", async () => {
    const token = await register("check-missing-key@nomad.test");
    const id = await tripFor(token, {
      destinationId: "rishikesh",
      start: "2027-10-10",
      end: "2027-10-14",
    });
    seedPacking(id, "flight");

    // Shape is a 400; existence stays behind the 404.
    const res = await check(token, id, {
      itemKey: "0123456789abcdef",
      checked: true,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("404s on another user's trip and leaves the row untouched", async () => {
    const owner = await register("check-owner@nomad.test");
    const stranger = await register("check-stranger@nomad.test");
    const id = await tripFor(owner, {
      destinationId: "mcleodganj",
      start: "2027-10-20",
      end: "2027-10-24",
    });
    const [first] = seedPacking(id, "flight");

    const res = await check(stranger, id, { itemKey: first, checked: true });
    expect(res.status).toBe(404);
    // A 404 that still wrote is the bug this catches: ownership lives inside the
    // UPDATE, so the status and the row have to agree. Read back from the table,
    // not from the route.
    expect(checkedFlag(id, first)).toBe(0);
    expect((await getPacking(owner, id)).body.checkedCount).toBe(0);
  });

  it("401s without a bearer token", async () => {
    const token = await register("check-401@nomad.test");
    const id = await tripFor(token, {
      destinationId: "pokhara",
      start: "2027-11-01",
      end: "2027-11-05",
    });
    const [first] = seedPacking(id, "flight");

    const res = await request(app)
      .post(`/api/trips/${id}/packing/check`)
      .send({ itemKey: first, checked: true });
    expect(res.status).toBe(401);
    expect(checkedFlag(id, first)).toBe(0);
  });
});

describe("DELETE /api/trips/:id packing cascade", () => {
  it("takes the checklist rows with it", async () => {
    const token = await register("cascade-owner@nomad.test");
    const id = await tripFor(token, {
      destinationId: "bali",
      start: "2027-11-10",
      end: "2027-11-16",
    });
    const keys = seedPacking(id, "flight");
    expect(packingRowCount(id)).toBe(keys.length);

    expect(
      (
        await request(app)
          .delete(`/api/trips/${id}`)
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(204);

    // `PRAGMA foreign_keys` is off — `trip_packing`'s bare REFERENCES is
    // documentation — so this cascade is explicit application code, not a
    // database guarantee. Nothing enforces it if the DELETE is ever reordered
    // or dropped, which is exactly why it is asserted against the table.
    expect(packingRowCount(id)).toBe(0);
  });

  it("leaves another user's checklist rows alone", async () => {
    const alice = await register("cascade-alice@nomad.test");
    const bob = await register("cascade-bob@nomad.test");
    const aliceTrip = await tripFor(alice, {
      destinationId: "dubai",
      start: "2027-11-20",
      end: "2027-11-24",
    });
    const bobTrip = await tripFor(bob, {
      destinationId: "dubai",
      start: "2027-11-20",
      end: "2027-11-24",
    });
    seedPacking(aliceTrip, "flight");
    const bobKeys = seedPacking(bobTrip, "flight");
    await check(bob, bobTrip, { itemKey: bobKeys[0], checked: true });

    expect(
      (
        await request(app)
          .delete(`/api/trips/${aliceTrip}`)
          .set("Authorization", `Bearer ${alice}`)
      ).status,
    ).toBe(204);

    expect(packingRowCount(aliceTrip)).toBe(0);
    // Same destination, same dates, same item keys — the two users' rows are
    // told apart by `trip_id` alone, so an unscoped delete would take both.
    expect(packingRowCount(bobTrip)).toBe(bobKeys.length);
    expect(checkedFlag(bobTrip, bobKeys[0])).toBe(1);
  });
});
