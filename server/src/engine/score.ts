import type { Destination } from "../types.js";

const DAY_MS = 86_400_000;

export function tripDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/** Fraction of trip days falling in each covered month (keys 0–11). */
function monthWeights(start: Date, end: Date): Map<number, number> {
  const weights = new Map<number, number>();
  const days = tripDays(start, end);
  const cursor = new Date(start);
  for (let i = 0; i < days; i++) {
    const m = cursor.getUTCMonth();
    weights.set(m, (weights.get(m) ?? 0) + 1 / days);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return weights;
}

/**
 * Score a destination for a date range. Higher is better.
 * Weather fit (0–10, dominant) + trip-length fit − distance penalty
 * for trips too short to justify the journey.
 * `distanceKm` is the road distance from the user's home city.
 */
export function scoreDestination(
  dest: Destination,
  start: Date,
  end: Date,
  distanceKm: number,
): number {
  const days = tripDays(start, end);

  let weatherFit = 0;
  for (const [month, weight] of monthWeights(start, end)) {
    weatherFit += dest.monthScores[month] * weight;
  }

  // 1 when the trip is long enough; decays when days < idealDays.
  const lengthFit = Math.min(1, days / dest.idealDays);

  // Short trips to far places hurt; a 2-day trip to a 2000 km place
  // loses up to ~2.5 points, a long trip loses almost nothing.
  const distancePenalty =
    (distanceKm / 1000) * Math.max(0, 1 - days / dest.idealDays);

  return weatherFit * lengthFit - distancePenalty;
}
