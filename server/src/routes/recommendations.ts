import { Router } from "express";
import { recommend } from "../engine/recommend.js";
import { allDestinations } from "../data/index.js";
import { HOME_BASE } from "../data/constants.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const recommendationsRouter = Router();

recommendationsRouter.get("/api/recommendations", (req, res) => {
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);
  const seed = req.query.seed === undefined ? 0 : Number(req.query.seed);

  if (!start || !end || start > end || !Number.isInteger(seed)) {
    res.status(400).json({
      error: "expected start & end as YYYY-MM-DD (start <= end), integer seed",
    });
    return;
  }

  res.json({ homeBase: HOME_BASE, ...recommend(start, end, seed) });
});

recommendationsRouter.get("/api/destinations/:id", (req, res) => {
  const dest = allDestinations.find((d) => d.id === req.params.id);
  if (!dest) {
    res.status(404).json({ error: `unknown destination "${req.params.id}"` });
    return;
  }
  res.json(dest);
});
