export type TravelMode = "flight" | "bike" | "bus";
export type Scope = "india" | "international";
export type BudgetTier = "₹" | "₹₹" | "₹₹₹";

export interface MonthWeather {
  tempMin: number;
  tempMax: number;
  summary: string;
}

export interface Destination {
  id: string;
  name: string;
  region: string;
  country: string;
  scope: Scope;
  /** [lat, lng] — distances are computed from the user's home city. */
  coords: [number, number];
  /** Whether this is a good ride/drive destination at all (roads, terrain). */
  roadTrip: boolean;
  /** Minimum days the trip really needs. */
  idealDays: number;
  /** Jan..Dec fit score, 0–10. Encodes monsoon, heat, snow, peak season. */
  monthScores: number[];
  /** Jan..Dec typical weather. */
  weather: MonthWeather[];
  budgetTier: BudgetTier;
  tags: string[];
  blurb: string;
  /** CSS gradient string used as the card hero. */
  heroGradient: string;
  bestFor: string;
}
