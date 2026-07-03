import type {
  CalendarMonth,
  City,
  Destination,
  Recommendations,
  TripFilters,
  Vibe,
} from "./types";

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
  cityId: string,
): Promise<CalendarMonth> {
  return getJson(`/api/calendar/${year}/${month}?city=${cityId}`);
}

export function fetchRecommendations(
  start: string,
  end: string,
  cityId: string,
  filters: TripFilters,
  seed = 0,
): Promise<Recommendations> {
  const params = new URLSearchParams({
    start,
    end,
    seed: String(seed),
    city: cityId,
  });
  if (filters.budget) params.set("budget", filters.budget);
  if (filters.vibes.length > 0) params.set("vibes", filters.vibes.join(","));
  return getJson(`/api/recommendations?${params}`);
}

export function fetchDestination(id: string): Promise<Destination> {
  return getJson(`/api/destinations/${id}`);
}

export function fetchCities(): Promise<{ cities: City[] }> {
  return getJson("/api/cities");
}

export function fetchVibes(): Promise<{ vibes: Vibe[] }> {
  return getJson("/api/vibes");
}
