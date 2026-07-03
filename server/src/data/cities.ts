export interface City {
  id: string;
  name: string;
  emoji: string;
  coords: [number, number];
}

/** Home-base cities, BookMyShow-style: big metros first, landmark emoji each. */
export const cities: City[] = [
  { id: "delhi-ncr", name: "Delhi-NCR", emoji: "🏛️", coords: [28.61, 77.21] },
  { id: "mumbai", name: "Mumbai", emoji: "🌊", coords: [19.08, 72.88] },
  { id: "bengaluru", name: "Bengaluru", emoji: "💻", coords: [12.97, 77.59] },
  { id: "hyderabad", name: "Hyderabad", emoji: "🕌", coords: [17.38, 78.48] },
  { id: "chennai", name: "Chennai", emoji: "🏖️", coords: [13.08, 80.27] },
  { id: "kolkata", name: "Kolkata", emoji: "🌉", coords: [22.57, 88.36] },
  { id: "pune", name: "Pune", emoji: "⛰️", coords: [18.52, 73.86] },
  { id: "ahmedabad", name: "Ahmedabad", emoji: "🪁", coords: [23.02, 72.57] },
];

export const DEFAULT_CITY_ID = "delhi-ncr";

export function cityById(id: string | undefined): City {
  return cities.find((c) => c.id === id) ?? cities[0];
}
