import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth/tokens.js";
import { allDestinations } from "../data/index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["planned", "taken", "skipped"] as const;
const MODES = ["flight", "bike", "bus"];

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

tripsRouter.get("/api/trips", (req: AuthedRequest, res) => {
  const trips = db
    .prepare("SELECT * FROM trips WHERE user_id = ? ORDER BY start DESC")
    .all(req.userId);
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
  const info = db
    .prepare("DELETE FROM trips WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.userId);
  if (info.changes === 0) {
    res.status(404).json({ error: "no such trip" });
    return;
  }
  res.status(204).end();
});
