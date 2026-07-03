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
  modes: TravelMode[];
  /** Road distance from HOME_BASE in km (approx; flight-only picks use air-ish distance). */
  distanceKm: number;
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
