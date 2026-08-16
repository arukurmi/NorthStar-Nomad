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

/* ------------------------------------------------------------------ *
 * F2 — packing lists. Mirrors `server/src/ai/packing.ts`,
 * `server/src/ai/packingStore.ts` and the two trip-scoped routes.
 * ------------------------------------------------------------------ */

export interface PackingItem {
  /**
   * 16 lowercase hex characters, derived server-side. The client only ever
   * echoes one back; it never computes a key, which is why a regenerated list
   * keeps its ticks without the UI knowing anything about how they are derived.
   */
  itemKey: string;
  label: string;
  qty: number;
  /** Absent when the item is obvious. Never rendered as an empty line. */
  reason?: string;
}

export interface PackingCategory {
  name: string;
  /** The one mode-specific section. Expanded by default, so the client never
   *  has to string-match a heading to decide which that is. */
  modeCategory: boolean;
  items: PackingItem[];
}

export interface PackingList {
  summary: string;
  categories: PackingCategory[];
}

/** Per-user tick state. Deliberately outside `PackingList`: the list is served
 *  from a cache shared by every user, and this never is. */
export interface PackingTripState {
  id: number;
  /** itemKey → checked, indexed directly by the checkbox rows. */
  checked: Record<string, boolean>;
  checkedCount: number;
  total: number;
}

export interface PackingRequest {
  destinationId: string;
  start: string;
  end: string;
  mode: TravelMode;
  tripId?: number;
  provider?: ProviderId;
}

export interface PackingResponse {
  cached: boolean;
  /** ISO-8601 with a zone marker. The stored row's time on a hit. */
  generatedAt: string;
  packing: PackingList;
  /** Absent when no saved trip matches — the signal to disable ticking. */
  trip?: PackingTripState;
}

/** A stored item, as the trip-scoped read returns it. Carries `checked`, which
 *  `PackingItem` never does. */
export interface StoredPackingItem extends PackingItem {
  checked: boolean;
}

export interface StoredPackingCategory {
  name: string;
  modeCategory: boolean;
  items: StoredPackingItem[];
}

export interface TripPackingResponse {
  /** `[]` for a trip with nothing generated — a correct answer, not an error. */
  categories: StoredPackingCategory[];
  checkedCount: number;
  total: number;
}

export interface PackingCheckResponse {
  itemKey: string;
  checked: boolean;
  /** Authoritative, recomputed server-side — never the client's arithmetic. */
  checkedCount: number;
  total: number;
}
