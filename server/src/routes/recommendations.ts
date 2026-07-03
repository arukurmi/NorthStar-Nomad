import { Router } from "express";
import { recommend } from "../engine/recommend.js";
import { allDestinations } from "../data/index.js";
import { cities, cityById } from "../data/cities.js";
import { VIBES } from "../engine/vibes.js";
import type { BudgetTier } from "../types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BUDGETS: BudgetTier[] = ["₹", "₹₹", "₹₹₹"];

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const recommendationsRouter = Router();

recommendationsRouter.get("/api/cities", (_req, res) => {
  res.json({ cities });
});

recommendationsRouter.get("/api/vibes", (_req, res) => {
  res.json({
    vibes: Object.entries(VIBES).map(([id, v]) => ({
      id,
      emoji: v.emoji,
      label: v.label,
    })),
  });
});

recommendationsRouter.get("/api/recommendations", (req, res) => {
  const start = parseIso(req.query.start);
  const end = parseIso(req.query.end);
  const seed = req.query.seed === undefined ? 0 : Number(req.query.seed);
  const cityId = typeof req.query.city === "string" ? req.query.city : undefined;
  const budgetRaw = req.query.budget;
  const budget =
    typeof budgetRaw === "string" && BUDGETS.includes(budgetRaw as BudgetTier)
      ? (budgetRaw as BudgetTier)
      : undefined;
  const vibes =
    typeof req.query.vibes === "string" && req.query.vibes.length > 0
      ? req.query.vibes.split(",").filter((v) => v in VIBES)
      : [];

  if (!start || !end || start > end || !Number.isInteger(seed)) {
    res.status(400).json({
      error: "expected start & end as YYYY-MM-DD (start <= end), integer seed",
    });
    return;
  }

  const city = cityById(cityId);
  res.json({
    homeBase: city.name,
    ...recommend(start, end, { seed, cityId, budget, vibes }),
  });
});

recommendationsRouter.get("/api/destinations/:id", (req, res) => {
  const dest = allDestinations.find((d) => d.id === req.params.id);
  if (!dest) {
    res.status(404).json({ error: `unknown destination "${req.params.id}"` });
    return;
  }
  res.json(dest);
});
