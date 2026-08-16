import { Router } from "express";
import type { Response } from "express";
import { db } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth/tokens.js";
import { allDestinations } from "../data/index.js";
import {
  readStoredList,
  readTickState,
  setChecked,
} from "../ai/packingStore.js";
import type { TravelMode } from "../types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["planned", "taken", "skipped"] as const;
const MODES = ["flight", "bike", "bus"];

/**
 * The packing routes answer with a machine-readable `code`, matching the AI
 * routes' `sendLocalError` — the web client branches on it rather than on copy.
 * The older trip routes below answer `{ error }` with no `code`; retrofitting
 * them would change a shipped response shape and is a separate change.
 */
type PackingErrorCode = "bad_request" | "not_found";

function sendPackingError(
  res: Response,
  status: number,
  code: PackingErrorCode,
  error: string,
): void {
  res.status(status).json({ error, code });
}

/**
 * `:id` must be a positive integer, and anything else is a **404 rather than a
 * 400**: an id that is not an integer cannot name a row, so answering
 * differently for "malformed" and "not yours" would tell a caller which trip
 * ids exist. One shape of miss, no oracle.
 */
function parseTripId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface TripModeRow {
  mode: TravelMode;
}

export const tripsRouter = Router();

// Every trip route is per-user: authentication required, and rows are
// always scoped by user_id so nobody can read or edit another user's trips.
tripsRouter.use("/api/trips", requireAuth);

tripsRouter.post("/api/trips", (req: AuthedRequest, res) => {
  const { destinationId, start, end, mode } = req.body ?? {};
  const dest = allDestinations.find((d) => d.id === destinationId);
  if (
    !dest ||
    typeof start !== "string" ||
    !ISO_DATE.test(start) ||
    typeof end !== "string" ||
    !ISO_DATE.test(end) ||
    start > end ||
    (mode !== undefined && !MODES.includes(mode))
  ) {
    res.status(400).json({
      error: "need a known destinationId and start/end as YYYY-MM-DD",
    });
    return;
  }
  const duplicate = db
    .prepare(
      "SELECT id FROM trips WHERE user_id = ? AND destination_id = ? AND start = ?",
    )
    .get(req.userId, dest.id, start);
  if (duplicate) {
    res.status(409).json({ error: "this trip is already in your plans" });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO trips (user_id, destination_id, destination_name, start, end, mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(req.userId, dest.id, dest.name, start, end, mode ?? "flight");
  const trip = db
    .prepare("SELECT * FROM trips WHERE id = ?")
    .get(info.lastInsertRowid);
  res.status(201).json({ trip });
});

/**
 * The two packing counts ride along on the list rather than being fetched per
 * row. The profile page renders a collapsed progress card for every trip, and
 * the alternative is one GET /api/trips/:id/packing per row on mount — an N+1
 * for a progress bar. The full checklist is still fetched lazily, only when a
 * card is actually expanded.
 *
 * `t.*` returns exactly the columns `SELECT *` returned before, so nothing new
 * is exposed; the aggregate is additive and reads 0/0 for a trip with no list.
 */
tripsRouter.get("/api/trips", (req: AuthedRequest, res) => {
  const trips = db
    .prepare(
      `SELECT t.*,
              COALESCE(p.total, 0)   AS packing_total,
              COALESCE(p.checked, 0) AS packing_checked
         FROM trips t
         LEFT JOIN (
               SELECT trip_id,
                      COUNT(*)      AS total,
                      SUM(checked)  AS checked
                 FROM trip_packing
                -- Correlated to this caller. Without the WHERE, SQLite
                -- materialises the aggregate over *every* user's rows on every
                -- request (confirmed with EXPLAIN QUERY PLAN: MATERIALIZE p,
                -- then a full SCAN of trip_packing). One account generating
                -- lists at the route's own rate limit adds ~1,400 rows an hour,
                -- and every other user's profile page would pay for that scan
                -- synchronously on better-sqlite3's single thread.
                WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)
                GROUP BY trip_id
              ) p ON p.trip_id = t.id
        WHERE t.user_id = ?
        ORDER BY t.start DESC`,
    )
    .all(req.userId, req.userId);
  res.json({ trips });
});

/** Planned trips that have ended — the ones to ask "did you take it?" about. */
tripsRouter.get("/api/trips/check-in", (req: AuthedRequest, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const trips = db
    .prepare(
      "SELECT * FROM trips WHERE user_id = ? AND status = 'planned' AND end < ? ORDER BY end ASC",
    )
    .all(req.userId, today);
  res.json({ trips });
});

/**
 * The rehydrate-on-reload endpoint. It reads `trip_packing` and nothing else:
 * no AI key, no provider call, no cache lookup. That is the whole reason the
 * snapshot design exists — after a reload, or 31 days later when the cache row
 * has expired, the list *and* the ticks are still here, and the profile page
 * can render and tick a list with no key configured at all.
 *
 * Registered ahead of the `/api/trips/:id` handlers below. Express matches in
 * registration order and `:id` matches a single segment, so `:id/packing`
 * cannot be shadowed by it today — the position is deliberate so that adding a
 * `GET /api/trips/:id` later cannot quietly swallow this route.
 */
tripsRouter.get("/api/trips/:id/packing", (req: AuthedRequest, res) => {
  const tripId = parseTripId(req.params.id);
  if (tripId === null) {
    sendPackingError(res, 404, "not_found", "no such trip");
    return;
  }
  // Scoped by user_id, so someone else's trip and no trip at all are the same
  // miss. `mode` is what `readStoredList` needs to flag the mode category.
  const trip = db
    .prepare("SELECT mode FROM trips WHERE id = ? AND user_id = ?")
    .get(tripId, req.userId) as TripModeRow | undefined;
  if (!trip) {
    sendPackingError(res, 404, "not_found", "no such trip");
    return;
  }
  // An owned trip with nothing generated yet answers `[]` and zero counts. An
  // empty list is a correct answer here, not an error.
  const { checkedCount, total } = readTickState(tripId);
  res.json({
    categories: readStoredList(tripId, trip.mode),
    checkedCount,
    total,
  });
});

tripsRouter.post("/api/trips/:id/packing/check", (req: AuthedRequest, res) => {
  const tripId = parseTripId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { itemKey, checked } = body;
  // The key's *shape* is a 400 while a well-shaped key that is not on this
  // trip's list is a 404. The split is deliberate: a key that is not 16 hex
  // characters could never exist for any trip, so saying so reveals nothing
  // about this user's data, and it tells a client with a bug the truth instead
  // of sending it hunting for a missing item. Existence stays behind the 404.
  if (
    typeof itemKey !== "string" ||
    !/^[0-9a-f]{16}$/.test(itemKey) ||
    typeof checked !== "boolean"
  ) {
    sendPackingError(
      res,
      400,
      "bad_request",
      "itemKey must be 16 hex characters and checked must be a boolean",
    );
    return;
  }
  const state =
    tripId === null
      ? null
      : setChecked({ tripId, userId: req.userId as number, itemKey, checked });
  // One message for all three misses — the trip is someone else's, the trip is
  // gone, or the item is not on its list. No existence oracle, matching every
  // other 404 in this file.
  if (!state) {
    sendPackingError(res, 404, "not_found", "no such trip or item");
    return;
  }
  // The counts come from the store, recomputed from the rows — never the
  // client's arithmetic, so two open tabs converge instead of drifting.
  res.json({
    itemKey,
    checked,
    checkedCount: state.checkedCount,
    total: state.total,
  });
});

tripsRouter.patch("/api/trips/:id", (req: AuthedRequest, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status)) {
    res.status(400).json({ error: "status must be planned, taken, or skipped" });
    return;
  }
  // Scoped by user_id: updating someone else's trip is a 404, not a leak.
  const info = db
    .prepare("UPDATE trips SET status = ? WHERE id = ? AND user_id = ?")
    .run(status, req.params.id, req.userId);
  if (info.changes === 0) {
    res.status(404).json({ error: "no such trip" });
    return;
  }
  res.json({
    trip: db.prepare("SELECT * FROM trips WHERE id = ?").get(req.params.id),
  });
});

tripsRouter.delete("/api/trips/:id", (req: AuthedRequest, res) => {
  // `PRAGMA foreign_keys` is off — `trip_packing`'s bare REFERENCES is
  // documentation, not a cascade — so the checklist rows have to go explicitly,
  // mirroring how `ai-keys.ts` cleans up `ai_prefs`. One transaction, and the
  // packing delete runs *first* because it resolves ownership through the trip
  // row: after the trip is gone there is nothing left to scope it by.
  const remove = db.transaction(() => {
    db.prepare(
      `DELETE FROM trip_packing
        WHERE trip_id = (SELECT id FROM trips WHERE id = ? AND user_id = ?)`,
    ).run(req.params.id, req.userId);
    return db
      .prepare("DELETE FROM trips WHERE id = ? AND user_id = ?")
      .run(req.params.id, req.userId);
  });
  const info = remove();
  if (info.changes === 0) {
    res.status(404).json({ error: "no such trip" });
    return;
  }
  res.status(204).end();
});
