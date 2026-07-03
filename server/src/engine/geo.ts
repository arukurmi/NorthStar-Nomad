import type { Destination, TravelMode } from "../types.js";

/** Roads wiggle; haversine doesn't. */
const ROAD_FACTOR = 1.3;

export function haversineKm(
  [lat1, lon1]: [number, number],
  [lat2, lon2]: [number, number],
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function roadDistanceKm(
  from: [number, number],
  to: [number, number],
): number {
  return Math.round(haversineKm(from, to) * ROAD_FACTOR);
}

const BIKE_MAX_KM = 700;
const BUS_MAX_KM = 1100;
const FLIGHT_MIN_KM = 450;
/** Too close to home to be a "trip" at all. */
const MIN_TRIP_KM = 40;

/** Which travel modes make sense for this destination from this distance. */
export function eligibleModes(
  dest: Destination,
  distanceKm: number,
): TravelMode[] {
  if (dest.scope === "international") return ["flight"];
  if (distanceKm < MIN_TRIP_KM) return [];
  const modes: TravelMode[] = [];
  if (distanceKm >= FLIGHT_MIN_KM || !dest.roadTrip) modes.push("flight");
  if (dest.roadTrip && distanceKm <= BIKE_MAX_KM) modes.push("bike");
  if (dest.roadTrip && distanceKm <= BUS_MAX_KM) modes.push("bus");
  return modes;
}
