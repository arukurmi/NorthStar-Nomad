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
  distanceKm: number;
  idealDays: number;
  monthScores: number[];
  weather: MonthWeather[];
  budgetTier: BudgetTier;
  tags: string[];
  blurb: string;
  heroGradient: string;
  bestFor: string;
}

export interface DayInfo {
  date: string;
  isWeekend: boolean;
  holiday?: string;
}

export interface LongWeekend {
  start: string;
  end: string;
  days: number;
  label: string;
  holidayName?: string;
}

export interface Teaser {
  name: string;
  mode: TravelMode;
  emoji: string;
}

export interface CalendarMonth {
  year: number;
  month: number;
  days: DayInfo[];
  longWeekends: LongWeekend[];
  teasers: Record<string, Teaser>;
}

export interface Pick {
  destination: Destination;
  score: number;
  whyNow: string;
  weatherNow: MonthWeather;
}

export interface Recommendations {
  homeBase: string;
  india: Record<TravelMode, Pick[]>;
  international: Pick[];
  shoulderSeason: boolean;
}
