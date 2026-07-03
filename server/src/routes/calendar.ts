import { Router } from "express";
import { holidayByDate } from "../data/holidays.js";
import { findLongWeekends, toIso } from "../engine/weekends.js";
import { recommend } from "../engine/recommend.js";
import type { TravelMode } from "../types.js";

const MODE_EMOJI: Record<TravelMode, string> = {
  flight: "✈️",
  bike: "🏍️",
  bus: "🚌",
};

export interface DayInfo {
  date: string;
  isWeekend: boolean;
  holiday?: string;
}

export interface Teaser {
  name: string;
  mode: TravelMode;
  emoji: string;
}

function bestTeaser(
  start: Date,
  end: Date,
  cityId: string | undefined,
  variety: number,
): Teaser {
  const r = recommend(start, end, { cityId });
  const candidates: { mode: TravelMode; score: number; name: string }[] = [];
  for (const mode of ["flight", "bike", "bus"] as TravelMode[]) {
    for (const pick of r.india[mode]) {
      candidates.push({
        mode,
        score: pick.score,
        name: pick.destination.name,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  // Rotate through the top few so a month of Saturdays isn't one destination.
  const top = candidates.slice(0, Math.min(4, candidates.length));
  const best = top[variety % top.length];
  return { name: best.name, mode: best.mode, emoji: MODE_EMOJI[best.mode] };
}

export const calendarRouter = Router();

calendarRouter.get("/api/calendar/:year/:month", (req, res) => {
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  const cityId =
    typeof req.query.city === "string" ? req.query.city : undefined;
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 2020 ||
    year > 2100 ||
    month < 1 ||
    month > 12
  ) {
    res.status(400).json({ error: "invalid year or month" });
    return;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: DayInfo[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(Date.UTC(year, month - 1, d));
    const iso = toIso(date);
    const dow = date.getUTCDay();
    days.push({
      date: iso,
      isWeekend: dow === 0 || dow === 6,
      holiday: holidayByDate.get(iso),
    });
  }

  const longWeekends = findLongWeekends(year, month);
  const coveredByLongWeekend = new Set(
    longWeekends.flatMap((lw) => {
      const dates: string[] = [];
      const c = new Date(`${lw.start}T00:00:00Z`);
      const e = new Date(`${lw.end}T00:00:00Z`);
      while (c <= e) {
        dates.push(toIso(c));
        c.setUTCDate(c.getUTCDate() + 1);
      }
      return dates;
    }),
  );

  // Teasers: one per long weekend, plus one per plain Sat–Sun weekend.
  const teasers: Record<string, Teaser> = {};
  let weekendIndex = 0;
  for (const lw of longWeekends) {
    teasers[lw.start] = bestTeaser(
      new Date(`${lw.start}T00:00:00Z`),
      new Date(`${lw.end}T00:00:00Z`),
      cityId,
      weekendIndex++,
    );
  }
  for (const day of days) {
    const date = new Date(`${day.date}T00:00:00Z`);
    if (date.getUTCDay() === 6 && !coveredByLongWeekend.has(day.date)) {
      const sunday = new Date(date);
      sunday.setUTCDate(sunday.getUTCDate() + 1);
      teasers[day.date] = bestTeaser(date, sunday, cityId, weekendIndex++);
    }
  }

  res.json({ year, month, days, longWeekends, teasers });
});
