import { describe, it, expect } from "vitest";
import { db } from "../db.js";
import {
  MODE_CATEGORY_TITLE,
  itemKeyFor,
  parsePackingList,
  type PackingList,
} from "./packing.js";
import {
  findOwnedTrip,
  ownsTrip,
  readStoredList,
  readTickState,
  setChecked,
  syncTripPacking,
  type PackingTickState,
} from "./packingStore.js";
import type { TravelMode } from "../types.js";

/** A real user row — trips.user_id references users(id). */
function makeUser(email: string): number {
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Packing Nomad", email, "not-a-real-hash");
  return Number(info.lastInsertRowid);
}

interface TripSpec {
  destinationId?: string;
  start?: string;
  end?: string;
  mode?: TravelMode;
}

/** A real trip row — trip_packing.trip_id references trips(id), and every
 *  statement in the store resolves ownership through this table. */
function makeTrip(userId: number, spec: TripSpec = {}): number {
  const info = db
    .prepare(
      `INSERT INTO trips (user_id, destination_id, destination_name, start, end, mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      spec.destinationId ?? "spiti",
      "Spiti Valley",
      spec.start ?? "2026-06-12",
      spec.end ?? "2026-06-18",
      spec.mode ?? "bike",
    );
  return Number(info.lastInsertRowid);
}

/**
 * The fixture stands in for model output, so it is the raw shape the vendor
 * emits — `parsePackingList` is what turns it into a `PackingList` with real
 * `itemKey`s. Every key under test therefore comes out of `itemKeyFor`, exactly
 * as it will when the route persists a generated list; a hand-written 16-hex key
 * would be testing a value the store never actually sees.
 *
 * "Gear" carries four items rather than three so a prune test can drop one and
 * still satisfy `parsePackingList`'s minimum of three per category.
 */
interface RawItem {
  label: string;
  qty: number;
  reason?: string | null;
}
interface RawCategory {
  name: string;
  items: RawItem[];
}
interface RawList {
  summary: string;
  categories: RawCategory[];
}

/** Rebuilt on every call, so a mutation in one test cannot reach another. */
function rawList(): RawList {
  return {
    summary:
      "Spiti in June: cold nights at altitude and a river crossing that soaks everything below the knee.",
    categories: [
      {
        name: "Clothing",
        items: [
          {
            label: "Quick-dry shirts",
            qty: 3,
            reason: "Nothing cotton dries at 4,000 m.",
          },
          // Blank reason — parses to `undefined`, stores SQL NULL. The
          // omitted-not-null assertion below depends on this item.
          { label: "Rain liners", qty: 1, reason: "" },
          { label: "Riding gloves", qty: 2, reason: null },
        ],
      },
      {
        name: "Gear",
        items: [
          { label: "Tool kit", qty: 1, reason: "No workshop past Kaza." },
          { label: "Spare tubes", qty: 2 },
          { label: "Dry bag", qty: 1, reason: "The Chandra crossing." },
          { label: "Headlamp", qty: 1, reason: "Camps have no wiring." },
        ],
      },
      {
        name: "Mode — Bike",
        items: [
          { label: "Chain lube", qty: 1, reason: "Grit strips it in a day." },
          { label: "Tyre levers", qty: 2 },
          { label: "Helmet", qty: 1 },
        ],
      },
      {
        name: "Documents",
        items: [
          { label: "Inner line permit", qty: 2, reason: "Checked at Sumdo." },
          { label: "Insurance copy", qty: 1 },
          { label: "Driving licence", qty: 1 },
        ],
      },
    ],
  };
}

function packingList(mode: TravelMode = "bike"): PackingList {
  return parsePackingList(rawList(), mode);
}

/** Keys in the list's own order, spanning category boundaries — the order
 *  `sort_order` is supposed to encode. */
function flatKeys(list: PackingList): string[] {
  return list.categories.flatMap((category) =>
    category.items.map((item) => item.itemKey),
  );
}

interface Row {
  itemKey: string;
  category: string;
  label: string;
  qty: number;
  reason: string | null;
  sortOrder: number;
  checked: number;
}

function rows(tripId: number): Row[] {
  return db
    .prepare(
      `SELECT item_key AS itemKey, category, label, qty, reason,
              sort_order AS sortOrder, checked
         FROM trip_packing
        WHERE trip_id = ?
        ORDER BY sort_order`,
    )
    .all(tripId) as Row[];
}

function rowFor(tripId: number, itemKey: string): Row | undefined {
  return rows(tripId).find((row) => row.itemKey === itemKey);
}

const CLOTHING_LINERS = itemKeyFor("Clothing", "Rain liners");
const CLOTHING_SHIRTS = itemKeyFor("Clothing", "Quick-dry shirts");
const GEAR_TOOL_KIT = itemKeyFor("Gear", "Tool kit");
const GEAR_HEADLAMP = itemKeyFor("Gear", "Headlamp");
const MODE_HELMET = itemKeyFor("Mode — Bike", "Helmet");


/**
 * Syncs as the trip's real owner. syncTripPacking re-checks ownership inside
 * its own transaction, so every call has to name a user — that check is the
 * point, and a helper that guessed would defeat it.
 */
function sync(tripId: number, list: PackingList): PackingTickState {
  const owner = db
    .prepare("SELECT user_id AS userId FROM trips WHERE id = ?")
    .get(tripId) as { userId: number } | undefined;
  const state = syncTripPacking(tripId, owner?.userId ?? -1, list);
  if (!state) throw new Error(`sync helper: trip ${tripId} has no owner`);
  return state;
}

describe("syncTripPacking", () => {
  it("inserts one row per item across every category", () => {
    const tripId = makeTrip(makeUser("sync-insert@nomad.test"));
    const list = packingList();

    const state = sync(tripId, list);

    expect(rows(tripId)).toHaveLength(13);
    expect(state.total).toBe(13);
    expect(state.checkedCount).toBe(0);
    expect(Object.keys(state.checked).sort()).toEqual(flatKeys(list).sort());
    // A fresh list is entirely unticked.
    expect(Object.values(state.checked).every((value) => value === false)).toBe(
      true,
    );
  });

  it("stores sort_order as the flattened index across the whole list", () => {
    const tripId = makeTrip(makeUser("sync-order@nomad.test"));
    const list = packingList();
    sync(tripId, list);

    const stored = rows(tripId);
    // 0..n-1 with no restart at a category boundary — the profile card renders
    // straight off this column with nothing re-derived on read.
    expect(stored.map((row) => row.sortOrder)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(stored.map((row) => row.itemKey)).toEqual(flatKeys(list));
    expect(stored.map((row) => row.category)).toEqual([
      "Clothing",
      "Clothing",
      "Clothing",
      "Gear",
      "Gear",
      "Gear",
      "Gear",
      "Mode — Bike",
      "Mode — Bike",
      "Mode — Bike",
      "Documents",
      "Documents",
      "Documents",
    ]);
  });

  it("preserves checked across a re-sync of the same list", () => {
    // This is the guarantee the whole upsert-then-prune design exists for: a
    // truncate-and-reinsert would take every tick with it, so a regeneration
    // would silently reset a list the user had been working through for a week.
    const userId = makeUser("sync-preserve@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: CLOTHING_SHIRTS, checked: true });
    setChecked({ tripId, userId, itemKey: MODE_HELMET, checked: true });

    const state = sync(tripId, packingList());

    expect(state.checked[CLOTHING_SHIRTS]).toBe(true);
    expect(state.checked[MODE_HELMET]).toBe(true);
    expect(state.checkedCount).toBe(2);
    expect(state.total).toBe(13);
  });

  it("refreshes label, qty and reason without disturbing checked", () => {
    const userId = makeUser("sync-refresh@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: CLOTHING_LINERS, checked: true });

    // Cosmetic drift only: "Rain liners" and "rain  liners" slug identically,
    // so `itemKeyFor` collapses them onto the same key and the row is updated
    // rather than inserted alongside.
    const raw = rawList();
    raw.categories[0].items[1] = {
      label: "rain  liners",
      qty: 2,
      reason: "The pass is wet from noon on.",
    };
    const state = sync(tripId, parsePackingList(raw, "bike"));

    const row = rowFor(tripId, CLOTHING_LINERS);
    expect(row?.label).toBe("rain  liners");
    expect(row?.qty).toBe(2);
    expect(row?.reason).toBe("The pass is wet from noon on.");
    // `checked` is not in the DO UPDATE SET list — the wording moved, the tick
    // did not.
    expect(row?.checked).toBe(1);
    expect(state.checkedCount).toBe(1);
    expect(state.total).toBe(13);
  });

  it("prunes items the model dropped so total stays exact", () => {
    const tripId = makeTrip(makeUser("sync-prune@nomad.test"));
    sync(tripId, packingList());
    expect(rowFor(tripId, GEAR_HEADLAMP)).toBeDefined();

    const raw = rawList();
    raw.categories[1].items.splice(3, 1); // drop "Headlamp"
    const state = sync(tripId, parsePackingList(raw, "bike"));

    // A row nobody renders would otherwise sit in the denominator forever.
    expect(rowFor(tripId, GEAR_HEADLAMP)).toBeUndefined();
    expect(state.total).toBe(12);
    expect(Object.hasOwn(state.checked, GEAR_HEADLAMP)).toBe(false);
  });

  it("keeps ticks on surviving items while pruning others in the same re-sync", () => {
    const userId = makeUser("sync-prune-tick@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: GEAR_TOOL_KIT, checked: true });
    setChecked({ tripId, userId, itemKey: GEAR_HEADLAMP, checked: true });

    const raw = rawList();
    raw.categories[1].items.splice(3, 1);
    const state = sync(tripId, parsePackingList(raw, "bike"));

    expect(state.checked[GEAR_TOOL_KIT]).toBe(true);
    expect(state.checkedCount).toBe(1);
    expect(state.total).toBe(12);
  });

  it("does not resurrect a tick when a pruned item comes back", () => {
    const userId = makeUser("sync-resurrect@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: GEAR_HEADLAMP, checked: true });

    const pruned = rawList();
    pruned.categories[1].items.splice(3, 1);
    sync(tripId, parsePackingList(pruned, "bike"));
    // The row was deleted, so the third sync inserts a brand new one — the tick
    // went with the row rather than lingering somewhere to be reapplied.
    const state = sync(tripId, packingList());

    expect(state.checked[GEAR_HEADLAMP]).toBe(false);
    expect(state.checkedCount).toBe(0);
    expect(state.total).toBe(13);
  });

  it("scopes a sync to one trip", () => {
    const userId = makeUser("sync-scope@nomad.test");
    const first = makeTrip(userId);
    const second = makeTrip(userId, { destinationId: "ladakh" });
    sync(first, packingList());
    sync(second, packingList());

    setChecked({ tripId: first, userId, itemKey: MODE_HELMET, checked: true });

    // Identical item keys under two trips are two different checkboxes.
    expect(readTickState(first).checkedCount).toBe(1);
    expect(readTickState(second).checkedCount).toBe(0);
    expect(readTickState(second).checked[MODE_HELMET]).toBe(false);

    const raw = rawList();
    raw.categories[1].items.splice(3, 1);
    sync(second, parsePackingList(raw, "bike"));
    expect(readTickState(first).total).toBe(13);
    expect(readTickState(second).total).toBe(12);
  });

  it("removes every row when the list has no items left", () => {
    const tripId = makeTrip(makeUser("sync-empty@nomad.test"));
    sync(tripId, packingList());

    // `NOT IN ()` is a syntax error, so the empty case takes the unconditional
    // delete — which is also the correct meaning.
    const state = sync(tripId, { summary: "None.", categories: [] });

    expect(rows(tripId)).toEqual([]);
    expect(state).toEqual({ checked: {}, checkedCount: 0, total: 0 });
  });
});

describe("readTickState", () => {
  it("returns an empty state for a trip with nothing generated", () => {
    const tripId = makeTrip(makeUser("tick-empty@nomad.test"));
    expect(readTickState(tripId)).toEqual({
      checked: {},
      checkedCount: 0,
      total: 0,
    });
  });

  it("reports the fixture's concrete counts, not its own arithmetic", () => {
    // Deliberately literal. Asserting `keys(checked).length === total` would
    // restate the three lines under test and stay green even if the query lost
    // its `WHERE trip_id = ?`, because the map and the counts come from the
    // same wrong row set. Concrete numbers catch that.
    const userId = makeUser("tick-counts@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: CLOTHING_SHIRTS, checked: true });

    const state = readTickState(tripId);
    expect(state.total).toBe(13);
    expect(state.checkedCount).toBe(1);
    expect(state.checked[CLOTHING_SHIRTS]).toBe(true);
    expect(state.checked[CLOTHING_LINERS]).toBe(false);
  });

  it("counts only the named trip's rows", () => {
    // The assertion the tautological version could not make: a second trip's
    // rows must not reach these numbers.
    const userId = makeUser("tick-scope@nomad.test");
    const mine = makeTrip(userId);
    const other = makeTrip(makeUser("tick-scope-other@nomad.test"));
    sync(mine, packingList());
    sync(other, packingList());
    setChecked({ tripId: mine, userId, itemKey: CLOTHING_SHIRTS, checked: true });

    expect(readTickState(mine).total).toBe(13);
    expect(readTickState(other).total).toBe(13);
    expect(readTickState(other).checkedCount).toBe(0);
  });
});

describe("readStoredList", () => {
  it("returns an empty array for a trip with nothing generated", () => {
    const tripId = makeTrip(makeUser("stored-empty@nomad.test"));
    expect(readStoredList(tripId, "bike")).toEqual([]);
  });

  it("groups by category in sort_order and keeps item order within a category", () => {
    const tripId = makeTrip(makeUser("stored-order@nomad.test"));
    sync(tripId, packingList());

    const stored = readStoredList(tripId, "bike");
    expect(stored.map((category) => category.name)).toEqual([
      "Clothing",
      "Gear",
      "Mode — Bike",
      "Documents",
    ]);
    expect(stored[1].items.map((item) => item.label)).toEqual([
      "Tool kit",
      "Spare tubes",
      "Dry bag",
      "Headlamp",
    ]);
    expect(stored.flatMap((category) => category.items).map((i) => i.itemKey)).
      toEqual(flatKeys(packingList()));
  });

  it("flags exactly the category matching MODE_CATEGORY_TITLE for the mode", () => {
    const tripId = makeTrip(makeUser("stored-mode@nomad.test"));
    sync(tripId, packingList());

    const stored = readStoredList(tripId, "bike");
    const flagged = stored.filter((category) => category.modeCategory);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe(MODE_CATEGORY_TITLE.bike);

    // A different mode's heading is not in this list, so nothing is expanded by
    // default rather than the wrong section being expanded.
    const asFlight = readStoredList(tripId, "flight");
    expect(asFlight.some((category) => category.modeCategory)).toBe(false);
  });

  it("omits reason rather than returning null", () => {
    const tripId = makeTrip(makeUser("stored-reason@nomad.test"));
    sync(tripId, packingList());

    const clothing = readStoredList(tripId, "bike")[0];
    const liners = clothing.items.find(
      (item) => item.itemKey === CLOTHING_LINERS,
    );
    // `reason: null` would render an empty reason line after a reload, so the
    // stored shape must match the generated one exactly.
    expect(liners).toBeDefined();
    expect(Object.hasOwn(liners!, "reason")).toBe(false);

    const shirts = clothing.items.find(
      (item) => item.itemKey === CLOTHING_SHIRTS,
    );
    expect(shirts?.reason).toBe("Nothing cotton dries at 4,000 m.");
  });

  it("round-trips checked as a boolean, not 0/1", () => {
    const userId = makeUser("stored-boolean@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());
    setChecked({ tripId, userId, itemKey: MODE_HELMET, checked: true });

    const items = readStoredList(tripId, "bike").flatMap(
      (category) => category.items,
    );
    const helmet = items.find((item) => item.itemKey === MODE_HELMET);
    expect(helmet?.checked).toBe(true);
    expect(items.find((item) => item.itemKey === GEAR_TOOL_KIT)?.checked).toBe(
      false,
    );
    expect(items.every((item) => typeof item.checked === "boolean")).toBe(true);
  });
});

describe("setChecked", () => {
  it("round-trips a tick and an untick", () => {
    const userId = makeUser("set-roundtrip@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());

    const ticked = setChecked({
      tripId,
      userId,
      itemKey: GEAR_TOOL_KIT,
      checked: true,
    });
    expect(ticked?.checked[GEAR_TOOL_KIT]).toBe(true);
    expect(ticked?.checkedCount).toBe(1);

    const unticked = setChecked({
      tripId,
      userId,
      itemKey: GEAR_TOOL_KIT,
      checked: false,
    });
    expect(unticked?.checked[GEAR_TOOL_KIT]).toBe(false);
    expect(unticked?.checkedCount).toBe(0);
  });

  it("returns counts read back from the database, not echoed arithmetic", () => {
    const userId = makeUser("set-authoritative@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());

    setChecked({ tripId, userId, itemKey: GEAR_TOOL_KIT, checked: true });
    const second = setChecked({
      tripId,
      userId,
      itemKey: MODE_HELMET,
      checked: true,
    });

    // Two open tabs converge on the same numbers only because these come from
    // the rows rather than from the request that triggered the write.
    expect(second?.checkedCount).toBe(2);
    expect(second?.total).toBe(13);
  });

  it("is idempotent when the item is already checked", () => {
    const userId = makeUser("set-idempotent@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());

    const first = setChecked({
      tripId,
      userId,
      itemKey: GEAR_TOOL_KIT,
      checked: true,
    });
    const again = setChecked({
      tripId,
      userId,
      itemKey: GEAR_TOOL_KIT,
      checked: true,
    });
    expect(again).toEqual(first);
  });

  it("returns null for a trip belonging to another user and writes nothing", () => {
    const owner = makeUser("set-owner@nomad.test");
    const stranger = makeUser("set-stranger@nomad.test");
    const tripId = makeTrip(owner);
    sync(tripId, packingList());

    expect(
      setChecked({
        tripId,
        userId: stranger,
        itemKey: GEAR_TOOL_KIT,
        checked: true,
      }),
    ).toBeNull();

    // A 404 that still wrote is the bug this catches: ownership is in the
    // UPDATE's own WHERE clause, not a read-then-write the writer can skip.
    expect(rowFor(tripId, GEAR_TOOL_KIT)?.checked).toBe(0);
    expect(readTickState(tripId).checkedCount).toBe(0);
  });

  it("returns null for a trip id that does not exist", () => {
    const userId = makeUser("set-no-trip@nomad.test");
    expect(
      setChecked({
        tripId: 987654321,
        userId,
        itemKey: GEAR_TOOL_KIT,
        checked: true,
      }),
    ).toBeNull();
  });

  it("returns null for an item key that is not on this trip's list", () => {
    const userId = makeUser("set-no-item@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());

    // A well-formed key for an item the model never produced. null covers this
    // identically to "wrong owner", so the 404 is not an existence oracle.
    expect(
      setChecked({
        tripId,
        userId,
        itemKey: itemKeyFor("Gear", "Espresso machine"),
        checked: true,
      }),
    ).toBeNull();
    expect(readTickState(tripId).checkedCount).toBe(0);
  });

  it("returns null for a malformed itemKey and writes nothing", () => {
    const userId = makeUser("set-malformed@nomad.test");
    const tripId = makeTrip(userId);
    sync(tripId, packingList());

    const malformed = [
      "nope",
      "a".repeat(64),
      // Uppercase hex of a key that really is on this list, so the rejection is
      // the shape check and not a lookup miss.
      GEAR_TOOL_KIT.toUpperCase(),
      "",
      `${GEAR_TOOL_KIT} `,
    ];
    for (const itemKey of malformed) {
      expect(setChecked({ tripId, userId, itemKey, checked: true })).toBeNull();
    }

    expect(rowFor(tripId, GEAR_TOOL_KIT)?.checked).toBe(0);
    expect(readTickState(tripId).checkedCount).toBe(0);
  });
});

describe("findOwnedTrip", () => {
  const TUPLE = {
    destinationId: "spiti",
    start: "2026-06-12",
    end: "2026-06-18",
    mode: "bike" as TravelMode,
  };

  it("matches on the full tuple and returns the trip id", () => {
    const userId = makeUser("find-match@nomad.test");
    const tripId = makeTrip(userId, TUPLE);
    expect(findOwnedTrip({ userId, ...TUPLE })).toEqual({ id: tripId });
  });

  it("returns null when any single field of the tuple differs", () => {
    const userId = makeUser("find-mismatch@nomad.test");
    makeTrip(userId, TUPLE);

    // One assertion per field, so a dropped predicate names itself.
    expect(
      findOwnedTrip({ userId, ...TUPLE, destinationId: "ladakh" }),
    ).toBeNull();
    expect(findOwnedTrip({ userId, ...TUPLE, start: "2026-06-13" })).toBeNull();
    expect(findOwnedTrip({ userId, ...TUPLE, end: "2026-06-19" })).toBeNull();
    expect(findOwnedTrip({ userId, ...TUPLE, mode: "flight" })).toBeNull();
  });

  it("never crosses users", () => {
    const alice = makeUser("find-alice@nomad.test");
    const bob = makeUser("find-bob@nomad.test");
    makeTrip(alice, TUPLE);

    // Bob's identical tuple must not resolve to Alice's trip.
    expect(findOwnedTrip({ userId: bob, ...TUPLE })).toBeNull();
    const bobTrip = makeTrip(bob, TUPLE);
    expect(findOwnedTrip({ userId: bob, ...TUPLE })).toEqual({ id: bobTrip });
  });

  it("honours a supplied tripId that matches the tuple and the owner", () => {
    const userId = makeUser("find-by-id@nomad.test");
    const tripId = makeTrip(userId, TUPLE);
    expect(findOwnedTrip({ userId, ...TUPLE, tripId })).toEqual({ id: tripId });
  });

  it("returns null for a supplied tripId belonging to another user", () => {
    const alice = makeUser("find-id-alice@nomad.test");
    const bob = makeUser("find-id-bob@nomad.test");
    const aliceTrip = makeTrip(alice, TUPLE);

    // The route must never turn this into a 200 carrying Alice's trip id.
    expect(findOwnedTrip({ userId: bob, ...TUPLE, tripId: aliceTrip })).toBeNull();
  });

  it("returns null for a supplied tripId that exists but does not match the tuple", () => {
    const userId = makeUser("find-id-wrong-tuple@nomad.test");
    makeTrip(userId, TUPLE);
    const other = makeTrip(userId, { ...TUPLE, destinationId: "ladakh" });

    // The id is the caller's own, but it is not the trip this list describes.
    expect(findOwnedTrip({ userId, ...TUPLE, tripId: other })).toBeNull();
  });

  it("returns the lowest id when two of the caller's trips match", () => {
    const userId = makeUser("find-ambiguous@nomad.test");
    const first = makeTrip(userId, TUPLE);
    const second = makeTrip(userId, TUPLE);

    // Which trip a tick lands on must not depend on how SQLite walked the table.
    expect(second).toBeGreaterThan(first);
    expect(findOwnedTrip({ userId, ...TUPLE })).toEqual({ id: first });
  });
});

describe("ownsTrip", () => {
  it("is true for the owner, false for anyone else, false for a missing id", () => {
    const owner = makeUser("owns-owner@nomad.test");
    const stranger = makeUser("owns-stranger@nomad.test");
    const tripId = makeTrip(owner);

    expect(ownsTrip(tripId, owner)).toBe(true);
    expect(ownsTrip(tripId, stranger)).toBe(false);
    expect(ownsTrip(987654321, owner)).toBe(false);
  });
});

describe("owner-scoped reads", () => {
  it("returns nothing for a reader who does not own the trip", () => {
    // Both callers resolve ownership before getting here, so this is defence
    // in depth rather than a live hole — but it is the one place the "ownership
    // lives in the SQL" rule was a calling convention, and a convention is what
    // the third caller forgets.
    const owner = makeUser("reads-owner@nomad.test");
    const stranger = makeUser("reads-stranger@nomad.test");
    const tripId = makeTrip(owner);
    sync(tripId, packingList());

    expect(readTickState(tripId, owner).total).toBe(13);
    expect(readTickState(tripId, stranger)).toEqual({
      checked: {},
      checkedCount: 0,
      total: 0,
    });
    expect(readStoredList(tripId, "bike", owner).length).toBeGreaterThan(0);
    expect(readStoredList(tripId, "bike", stranger)).toEqual([]);
  });

  it("behaves as before when no user is named", () => {
    // The unscoped form is still used nowhere that has not already resolved
    // ownership; keeping it means this change added a guard rather than
    // rewriting every call site.
    const owner = makeUser("reads-unscoped@nomad.test");
    const tripId = makeTrip(owner);
    sync(tripId, packingList());
    expect(readTickState(tripId).total).toBe(13);
  });
});
