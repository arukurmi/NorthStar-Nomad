import type { MonthWeather } from "../types.js";

/** Compact month-weather builder: 12 tuples of [tempMin, tempMax, summary]. */
export function weather(
  ...months: [number, number, string][]
): MonthWeather[] {
  if (months.length !== 12) {
    throw new Error(`expected 12 months, got ${months.length}`);
  }
  return months.map(([tempMin, tempMax, summary]) => ({
    tempMin,
    tempMax,
    summary,
  }));
}
