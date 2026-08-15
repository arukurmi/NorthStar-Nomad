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
  coords: [number, number];
  roadTrip: boolean;
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
  distanceKm: number;
  modes: TravelMode[];
}

export interface Recommendations {
  homeBase: string;
  india: Record<TravelMode, Pick[]>;
  international: Pick[];
  shoulderSeason: boolean;
  filtered: boolean;
}

export interface City {
  id: string;
  name: string;
  emoji: string;
  coords: [number, number];
}

export interface Vibe {
  id: string;
  emoji: string;
  label: string;
}

export interface TripFilters {
  budget: BudgetTier | null;
  vibes: string[];
}

/* ------------------------------------------------------------------ *
 * AI / BYOK — mirrors `server/src/ai/provider.ts` and `usage.ts`.
 * These are hand-mirrored rather than imported: `web/` and `server/` are
 * separate TypeScript projects with separate tsconfigs, and the wire
 * contract is what actually binds them.
 * ------------------------------------------------------------------ */

export type ProviderId = "anthropic" | "gemini" | "openai";

export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "gemini",
  "openai",
];

export type AiFeature = "itinerary" | "packing" | "budget" | "search";

/**
 * The redacted key shape — the only shape the server ever sends. There is no
 * field here that could hold the key itself, by design.
 */
export interface AiKeyPublic {
  provider: ProviderId;
  last4: string;
  model: string;
  validatedAt: string | null;
  preferred: boolean;
}

/**
 * `unauthenticated` and `invalid_key` both arrive as HTTP 401 and mean
 * completely different things: "your session is gone" versus "the provider
 * rejected that API key". Every branch in the UI reads this code, never the
 * status number.
 */
export type AiErrorCode =
  | "unauthenticated"
  | "bad_request"
  | "not_found"
  | "no_key"
  | "invalid_key"
  | "insufficient_credit"
  | "rate_limited"
  | "provider_error"
  | "bad_output";

export interface ErrorBody {
  error: string;
  code: AiErrorCode;
  provider?: ProviderId;
  /** Seconds. Only ever present for `rate_limited`. */
  retryAfter?: number;
}

export interface SaveKeyRequest {
  provider: ProviderId;
  apiKey: string;
  model?: string;
  preferred?: boolean;
}

export interface SaveKeyResponse {
  key: AiKeyPublic;
}

export interface KeysResponse {
  keys: AiKeyPublic[];
}

export interface UsageSummaryRow {
  feature: AiFeature;
  calls: number;
  /** Of `calls`, how many were served from the shared cache and cost nothing. */
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageResponse {
  usage: UsageSummaryRow[];
  totals: UsageTotals;
}
