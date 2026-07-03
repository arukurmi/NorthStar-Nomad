import type { BudgetTier, Destination, MonthWeather, TravelMode } from "../types.js";
import { allDestinations } from "../data/index.js";
import { cityById, type City } from "../data/cities.js";
import { scoreDestination, tripDays } from "./score.js";
import { eligibleModes, roadDistanceKm } from "./geo.js";
import { matchesVibes } from "./vibes.js";

export interface Pick {
  destination: Destination;
  score: number;
  whyNow: string;
  weatherNow: MonthWeather;
  /** Road distance from the chosen home city, km. */
  distanceKm: number;
  modes: TravelMode[];
}

export interface Recommendations {
  india: Record<TravelMode, Pick[]>;
  international: Pick[];
  shoulderSeason: boolean;
  /** True when budget/vibe filters were applied (empty pools are then honest, not bugs). */
  filtered: boolean;
}

export interface RecommendOptions {
  seed?: number;
  cityId?: string;
  budget?: BudgetTier;
  vibes?: string[];
}

const MODES: TravelMode[] = ["flight", "bike", "bus"];
const POOL_SIZE = 3;
const GOOD_SCORE = 6;

interface Scored {
  d: Destination;
  score: number;
  distanceKm: number;
  modes: TravelMode[];
}

function toPick(s: Scored, start: Date): Pick {
  const month = start.getUTCMonth();
  const w = s.d.weather[month];
  const monthScore = s.d.monthScores[month];
  const whyNow =
    monthScore >= 8
      ? `Peak season right now — ${w.summary.toLowerCase()}.`
      : monthScore >= 6
        ? `Good time to go — ${w.summary.toLowerCase()}.`
        : `Shoulder season, but the best pick for these dates — ${w.summary.toLowerCase()}.`;
  return {
    destination: s.d,
    score: s.score,
    whyNow,
    weatherNow: w,
    distanceKm: s.distanceKm,
    modes: s.modes,
  };
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
  options: RecommendOptions = {},
): Recommendations {
  const { seed = 0, budget, vibes = [] } = options;
  const city: City = cityById(options.cityId);
  const days = tripDays(start, end);
  const filtered = budget !== undefined || vibes.length > 0;

  const ranked: Scored[] = allDestinations
    .map((d) => {
      const distanceKm = roadDistanceKm(city.coords, d.coords);
      return {
        d,
        distanceKm,
        modes: eligibleModes(d, distanceKm),
        score: scoreDestination(d, start, end, distanceKm),
      };
    })
    .filter((s) => s.modes.length > 0)
    .filter((s) => !budget || s.d.budgetTier === budget)
    .filter((s) => matchesVibes(s.d, vibes))
    .sort((a, b) => b.score - a.score);

  const india = {} as Record<TravelMode, Pick[]>;
  for (const mode of MODES) {
    const eligible = ranked.filter(
      (s) => s.d.scope === "india" && s.modes.includes(mode),
    );
    let pool = eligible
      .filter((s) => s.d.idealDays <= days + 2)
      .slice(0, POOL_SIZE);
    // Never leave a mode empty for unfiltered requests: fall back to
    // best-available regardless of trip length.
    if (pool.length === 0 && !filtered) {
      pool = eligible.slice(0, POOL_SIZE);
    }
    india[mode] = rotate(
      pool.map((s) => toPick(s, start)),
      seed,
    );
  }

  const intlEligible = ranked.filter((s) => s.d.scope === "international");
  let intlPool = intlEligible
    .filter((s) => s.d.idealDays <= days + 3)
    .slice(0, POOL_SIZE);
  if (intlPool.length === 0 && !filtered) {
    intlPool = intlEligible.slice(0, POOL_SIZE);
  }
  const international = rotate(
    intlPool.map((s) => toPick(s, start)),
    seed,
  );

  const best = ranked[0]?.score ?? 0;
  return { india, international, shoulderSeason: best < GOOD_SCORE, filtered };
}
