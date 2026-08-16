import type { Statement } from "better-sqlite3";
import { db } from "../db.js";
import { MODE_CATEGORY_TITLE, type PackingList } from "./packing.js";
import type { TravelMode } from "../types.js";

/** One persisted checkbox. `reason` is absent — never null — when the model
 *  had nothing non-obvious to say, matching `PackingItem`. */
export interface StoredPackingItem {
  itemKey: string;
  label: string;
  qty: number;
  reason?: string;
  checked: boolean;
}

export interface StoredPackingCategory {
  name: string;
  modeCategory: boolean;
  items: StoredPackingItem[];
}

export interface PackingTickState {
  /** itemKey → checked. The shape the client indexes directly. */
  checked: Record<string, boolean>;
  checkedCount: number;
  total: number;
}

/**
 * The one shape a tick endpoint accepts. `itemKeyFor` produces exactly this, so
 * anything else is a client that invented a key rather than echoing one.
 */
const ITEM_KEY = /^[0-9a-f]{16}$/;

/**
 * `trip_packing` has no `user_id` column on purpose: `trips.user_id` is the one
 * owner, and a copy here would be a second source of truth that can disagree
 * with the first.
 *
 * Precisely which statements enforce that, because a comment claiming more than
 * the code does is worse than none:
 *
 * - `setChecked` resolves the owner **inside its own UPDATE**, so a non-owner's
 *   write changes zero rows. `changes === 0` is the caller's 404 signal.
 * - `syncTripPacking` re-checks ownership inside its transaction, because its
 *   caller resolved the trip before awaiting a vendor call.
 * - The read paths (`readTickState`, `readStoredList`) are scoped by `trip_id`
 *   alone and require a caller that has *already* resolved ownership. Both
 *   callers in `trips.ts` do, via a `user_id`-scoped lookup whose absence is
 *   the 404.
 */
const OWNED_TRIP = "(SELECT id FROM trips WHERE id = ? AND user_id = ?)";

/**
 * Matches on the whole tuple. `ORDER BY id LIMIT 1` is explicit rather than
 * relying on insertion order, and the reason is stronger than it first looks:
 * `trips` carries **no** unique constraint at all. The only duplicate check is
 * route logic in `trips.ts` on `(user_id, destination_id, start)`, so anything
 * writing rows another way — a future import, a fixture, a repair script — can
 * leave two identical trips behind. Which one a user's ticks land on must not
 * depend on how SQLite chose to walk the table.
 */
const selectOwnedTrip = db.prepare(`
  SELECT id FROM trips
  WHERE user_id = ?
    AND destination_id = ?
    AND start = ?
    AND end = ?
    AND mode = ?
  ORDER BY id
  LIMIT 1
`);

/** Same predicate plus the caller-supplied id, so a supplied id that belongs to
 *  someone else — or does not match the tuple — simply finds nothing. */
const selectOwnedTripById = db.prepare(`
  SELECT id FROM trips
  WHERE id = ?
    AND user_id = ?
    AND destination_id = ?
    AND start = ?
    AND end = ?
    AND mode = ?
  ORDER BY id
  LIMIT 1
`);

/**
 * Resolves the trip a generated list belongs to, or null.
 *
 * When `tripId` is given it must match the tuple *as well as* the owner. The
 * route turns null into "no trip to persist against", never into a 200 carrying
 * somebody else's trip id.
 */
export function findOwnedTrip(args: {
  userId: number;
  destinationId: string;
  start: string;
  end: string;
  mode: TravelMode;
  tripId?: number;
}): { id: number } | null {
  const row = (
    args.tripId === undefined
      ? selectOwnedTrip.get(
          args.userId,
          args.destinationId,
          args.start,
          args.end,
          args.mode,
        )
      : selectOwnedTripById.get(
          args.tripId,
          args.userId,
          args.destinationId,
          args.start,
          args.end,
          args.mode,
        )
  ) as { id: number } | undefined;
  return row ?? null;
}

const selectOwnership = db.prepare(
  "SELECT 1 FROM trips WHERE id = ? AND user_id = ?",
);

export function ownsTrip(tripId: number, userId: number): boolean {
  return selectOwnership.get(tripId, userId) !== undefined;
}

/**
 * `checked` is deliberately NOT in the DO UPDATE SET list. That single omission
 * is the entire "ticks survive a regeneration" guarantee: a regenerated list
 * refreshes the wording, quantity, reason and order of an item the user has
 * already ticked, and leaves the tick exactly where it was.
 *
 * `updated_at` moves on every upsert because the row's content did change.
 */
const upsertItem = db.prepare(`
  INSERT INTO trip_packing
    (trip_id, item_key, category, label, qty, reason, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(trip_id, item_key) DO UPDATE SET
    category   = excluded.category,
    label      = excluded.label,
    qty        = excluded.qty,
    reason     = excluded.reason,
    sort_order = excluded.sort_order,
    updated_at = datetime('now')
`);

const deleteAllForTrip = db.prepare(
  "DELETE FROM trip_packing WHERE trip_id = ?",
);

/**
 * The prune statement varies only in its placeholder count, and a list holds at
 * most 48 items (6 categories × 8, `parsePackingList`'s own maximum), so the
 * set of shapes is small and bounded — worth memoising rather than re-preparing
 * on every regeneration. Values are *never* concatenated into the SQL; only the
 * `?,?,?…` run is generated, from the key count alone.
 */
const pruneByKeyCount = new Map<number, Statement>();

function pruneStatement(keyCount: number): Statement {
  const cached = pruneByKeyCount.get(keyCount);
  if (cached) return cached;
  const placeholders = new Array<string>(keyCount).fill("?").join(",");
  const stmt = db.prepare(
    `DELETE FROM trip_packing
      WHERE trip_id = ? AND item_key NOT IN (${placeholders})`,
  );
  pruneByKeyCount.set(keyCount, stmt);
  return stmt;
}

/**
 * Persists a freshly generated list against a trip: upsert every item, then
 * prune whatever is no longer on it, in that order and in one transaction.
 *
 * Upsert-then-prune rather than truncate-then-insert, because a truncate would
 * take every tick with it. The prune is what keeps `total` exact when the model
 * drops an item between generations — a row nobody renders would otherwise sit
 * in the denominator forever.
 *
 * `sort_order` is the flattened index across the whole list (0, 1, 2, … across
 * all categories), so the profile card renders in the model's intended order
 * with nothing re-derived on read.
 */
export function syncTripPacking(
  tripId: number,
  userId: number,
  list: PackingList,
): PackingTickState | null {
  const sync = db.transaction((): PackingTickState | null => {
    // Re-resolved *inside* the transaction, not by the caller beforehand.
    // The AI route resolves the trip, then awaits a vendor call that can take
    // tens of seconds — better-sqlite3 is synchronous, so that await is the
    // only yield point in the request and it is a wide one. A DELETE
    // /api/trips/:id landing in that window removes the trip and its rows, and
    // an unguarded sync would then re-insert forty rows for a trip that no
    // longer exists. PRAGMA foreign_keys is off, so nothing rejects them and
    // the cascade has already run: they are unreachable dead storage forever.
    //
    // Not a cross-user leak — trips.id is AUTOINCREMENT, so an id is never
    // reused and those rows can never be adopted by somebody else's trip — but
    // a broken invariant, and this is the only place it can be closed without
    // a gap.
    if (!ownsTrip(tripId, userId)) return null;

    const keys: string[] = [];
    let sortOrder = 0;
    for (const category of list.categories) {
      for (const item of category.items) {
        upsertItem.run(
          tripId,
          item.itemKey,
          category.name,
          item.label,
          item.qty,
          item.reason ?? null,
          sortOrder,
        );
        keys.push(item.itemKey);
        sortOrder += 1;
      }
    }
    // `NOT IN ()` is a syntax error, so an empty list prunes unconditionally —
    // which is also the correct meaning: nothing is on the list any more.
    if (keys.length === 0) {
      deleteAllForTrip.run(tripId);
    } else {
      pruneStatement(keys.length).run(tripId, ...keys);
    }
    // Read back inside the transaction so the counts describe exactly the rows
    // just written, with no window for another writer in between.
    return readTickState(tripId);
  });

  return sync();
}

interface TickRow {
  itemKey: string;
  checked: number;
}

const selectTicks = db.prepare(`
  SELECT item_key AS itemKey, checked
  FROM trip_packing
  WHERE trip_id = ?
  ORDER BY sort_order
`);

/** One query. Counts are derived from the rows themselves, so `total` cannot
 *  disagree with the keys in `checked`. */
export function readTickState(tripId: number): PackingTickState {
  const rows = selectTicks.all(tripId) as TickRow[];
  const checked: Record<string, boolean> = {};
  let checkedCount = 0;
  for (const row of rows) {
    const isChecked = row.checked === 1;
    checked[row.itemKey] = isChecked;
    if (isChecked) checkedCount += 1;
  }
  return { checked, checkedCount, total: rows.length };
}

interface StoredRow {
  itemKey: string;
  category: string;
  label: string;
  qty: number;
  reason: string | null;
  checked: number;
}

const selectStored = db.prepare(`
  SELECT item_key AS itemKey, category, label, qty, reason, checked
  FROM trip_packing
  WHERE trip_id = ?
  ORDER BY sort_order
`);

/**
 * Rehydrates the stored snapshot with no AI call — which is what lets the
 * profile card render and tick a list long after the cache row has gone, and
 * with no key configured at all.
 *
 * `modeCategory` is derived by comparing the stored display string against
 * `MODE_CATEGORY_TITLE[mode]`, `mode` coming from the caller's `trips` row, so
 * the table needs no column for it. Categories come back in `sort_order`, which
 * is the model's intended order; `parsePackingList` rejects duplicate category
 * names, so grouping cannot silently merge two sections into one.
 */
export function readStoredList(
  tripId: number,
  mode: TravelMode,
): StoredPackingCategory[] {
  const modeTitle = MODE_CATEGORY_TITLE[mode];
  const categories: StoredPackingCategory[] = [];
  const byName = new Map<string, StoredPackingCategory>();

  for (const row of selectStored.all(tripId) as StoredRow[]) {
    let category = byName.get(row.category);
    if (!category) {
      category = {
        name: row.category,
        modeCategory: row.category === modeTitle,
        items: [],
      };
      byName.set(row.category, category);
      categories.push(category);
    }
    const item: StoredPackingItem = {
      itemKey: row.itemKey,
      label: row.label,
      qty: row.qty,
      checked: row.checked === 1,
    };
    // Absent, not `reason: null` — the stored shape must match the generated
    // one, or the client renders an empty reason line after a reload.
    if (row.reason !== null) item.reason = row.reason;
    category.items.push(item);
  }

  return categories;
}

const updateChecked = db.prepare(`
  UPDATE trip_packing
     SET checked = ?, updated_at = datetime('now')
   WHERE item_key = ?
     AND trip_id = ${OWNED_TRIP}
`);

/**
 * Ticks or unticks one item, returning the recomputed state or null.
 *
 * null covers every miss identically — the trip is someone else's, the trip is
 * gone, or the item is not on its list — so the 404 the route emits is not an
 * existence oracle. The returned counts are read back from the database rather
 * than echoed from the request, which is what makes two open tabs converge on
 * the same numbers instead of each drifting on its own arithmetic.
 */
export function setChecked(args: {
  tripId: number;
  userId: number;
  itemKey: string;
  checked: boolean;
}): PackingTickState | null {
  // Rejected before it reaches a statement: `itemKey` is the one field a client
  // supplies verbatim, and every real key is a 16-char hex digest.
  if (!ITEM_KEY.test(args.itemKey)) return null;

  const info = updateChecked.run(
    args.checked ? 1 : 0,
    args.itemKey,
    args.tripId,
    args.userId,
  );
  if (info.changes === 0) return null;

  return readTickState(args.tripId);
}
