import type { CalendarMonth, Destination, Recommendations } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export function fetchCalendarMonth(
  year: number,
  month: number,
): Promise<CalendarMonth> {
  return getJson(`/api/calendar/${year}/${month}`);
}

export function fetchRecommendations(
  start: string,
  end: string,
  seed = 0,
): Promise<Recommendations> {
  return getJson(`/api/recommendations?start=${start}&end=${end}&seed=${seed}`);
}

export function fetchDestination(id: string): Promise<Destination> {
  return getJson(`/api/destinations/${id}`);
}
