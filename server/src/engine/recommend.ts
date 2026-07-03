import type { Destination, MonthWeather, TravelMode } from "../types.js";
import { allDestinations } from "../data/index.js";
import { scoreDestination, tripDays } from "./score.js";

export interface Pick {
  destination: Destination;
  score: number;
  whyNow: string;
  weatherNow: MonthWeather;
}

export interface Recommendations {
  india: Record<TravelMode, Pick[]>;
  international: Pick[];
  shoulderSeason: boolean;
}

const MODES: TravelMode[] = ["flight", "bike", "bus"];
const POOL_SIZE = 3;
const GOOD_SCORE = 6;

function toPick(dest: Destination, score: number, start: Date): Pick {
  const month = start.getUTCMonth();
  const w = dest.weather[month];
  const monthScore = dest.monthScores[month];
  const whyNow =
    monthScore >= 8
      ? `Peak season right now — ${w.summary.toLowerCase()}.`
      : monthScore >= 6
        ? `Good time to go — ${w.summary.toLowerCase()}.`
        : `Shoulder season, but the best pick for these dates — ${w.summary.toLowerCase()}.`;
  return { destination: dest, score, whyNow, weatherNow: w };
}

/** Rotate a ranked pool by seed so refresh cycles alternatives deterministically. */
function rotate<T>(pool: T[], seed: number): T[] {
  if (pool.length === 0) return pool;
  const shift = ((seed % pool.length) + pool.length) % pool.length;
  return [...pool.slice(shift), ...pool.slice(0, shift)];
}

export function recommend(
  start: Date,
  end: Date,
  seed = 0,
): Recommendations {
  const days = tripDays(start, end);

  const ranked = allDestinations
    .map((d) => ({ d, score: scoreDestination(d, start, end) }))
    .sort((a, b) => b.score - a.score);

  const india = {} as Record<TravelMode, Pick[]>;
  for (const mode of MODES) {
    const pool = ranked
      .filter(
        ({ d }) =>
          d.scope === "india" &&
          d.modes.includes(mode) &&
          // Don't suggest trips needing far more days than available…
          d.idealDays <= days + 2,
      )
      .slice(0, POOL_SIZE)
      .map(({ d, score }) => toPick(d, score, start));
    // …but never leave a mode empty: fall back to best regardless of length.
    if (pool.length === 0) {
      const fallback = ranked.filter(
        ({ d }) => d.scope === "india" && d.modes.includes(mode),
      );
      pool.push(
        ...fallback
          .slice(0, POOL_SIZE)
          .map(({ d, score }) => toPick(d, score, start)),
      );
    }
    india[mode] = rotate(pool, seed);
  }

  const international = rotate(
    ranked
      .filter(({ d }) => d.scope === "international" && d.idealDays <= days + 3)
      .slice(0, POOL_SIZE)
      .map(({ d, score }) => toPick(d, score, start)),
    seed,
  );
  if (international.length === 0) {
    international.push(
      ...ranked
        .filter(({ d }) => d.scope === "international")
        .slice(0, POOL_SIZE)
        .map(({ d, score }) => toPick(d, score, start)),
    );
  }

  const best = ranked[0]?.score ?? 0;
  return { india, international, shoulderSeason: best < GOOD_SCORE };
}
