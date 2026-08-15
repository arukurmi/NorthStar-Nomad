import { MODE_CATEGORY_TITLE } from "../packing.js";
import type { Destination, TravelMode } from "../../types.js";

/**
 * Bumping this changes every packing cache key instantly and deliberately —
 * it travels in `options.pv`. It is the instrument for "the prompt changed",
 * which a TTL is far too slow and too imprecise to express.
 */
export const PACKING_PROMPT_VERSION = 1;

/**
 * A packing list is a function of static repository data — the destination row,
 * its month climatology, the trip length and the mode — so it does not decay
 * because the world moved. Expiry exists only so a catalogue correction reaches
 * users and so one bad generation is not permanent, and both work on a scale of
 * weeks. A cache hit is free, so a longer window is strictly pro-user: 30 days
 * covers a normal planning cycle end to end without re-billing anyone who
 * reopens the tab as the date approaches.
 */
export const PACKING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Row bound for the `packing` feature. ~32 destinations × 3 modes × ~5 live
 * date ranges ≈ 480, so 500 holds one model's entire realistic working set for
 * a month and only bites on fragmentation or abuse.
 */
export const PACKING_CACHE_LIMIT = 500;

/**
 * Hardcoded rather than derived from `toLocaleString`, which depends on the
 * host's ICU build and would make the committed fixtures machine-specific.
 */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Everything the prompt is allowed to know, and nothing else.
 *
 * There is no index signature, which is the structural half of the guarantee
 * that request text cannot reach a globally cached answer: `packingUserPrompt`
 * interpolates only these fields, so a property smuggled onto a runtime object
 * has no path into a prompt string that is not a compile error.
 */
export interface PackingGrounding {
  destinationName: string;
  region: string;
  country: string;
  international: boolean;
  roadTrip: boolean;
  idealDays: number;
  tags: string[];
  start: string;
  end: string;
  /** Inclusive day count: a 12th → 18th trip is 7 days, not 6. */
  days: number;
  /** Every calendar month the range touches, chronological, deduplicated. */
  months: string[];
  /** Coldest `tempMin` across the covered months. */
  tempMin: number;
  /** Hottest `tempMax` across the covered months. */
  tempMax: number;
  /** One "June — Monsoon arrives, rough seas" line per covered month. */
  weatherLines: string[];
  mode: TravelMode;
}

/**
 * Projects a catalogue row and an ISO range into the grounding facts.
 *
 * Walks the range day by day in UTC — same technique as the drawer's
 * `coveredMonths` — because a local-time cursor shifts a date across a DST
 * boundary and can drop or duplicate a month depending on where the machine
 * happens to be. The caller (`POST /api/ai/packing`) has already validated that
 * both dates are real calendar dates and that `start <= end`, so the loop always
 * runs at least once.
 *
 * `tempMin`/`tempMax` span **every** covered month, never the start month
 * alone. A 28 Jun → 2 Jul trip described with only June's numbers is exactly the
 * "cold nights in the desert" failure this feature exists to prevent.
 *
 * Pure by construction: no `Date.now()`, no `Math.random()`, no locale-dependent
 * formatting. That purity is what lets the committed fixtures be compared byte
 * for byte on any machine and in CI.
 */
export function buildGrounding(
  dest: Destination,
  start: string,
  end: string,
  mode: TravelMode,
): PackingGrounding {
  const monthIndexes: number[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  let days = 0;

  while (cursor <= last) {
    const month = cursor.getUTCMonth();
    if (!monthIndexes.includes(month)) monthIndexes.push(month);
    days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const covered = monthIndexes.map((m) => dest.weather[m]);

  return {
    destinationName: dest.name,
    region: dest.region,
    country: dest.country,
    international: dest.scope === "international",
    roadTrip: dest.roadTrip,
    idealDays: dest.idealDays,
    tags: dest.tags,
    start,
    end,
    days,
    months: monthIndexes.map((m) => MONTH_NAMES[m]),
    tempMin: Math.min(...covered.map((w) => w.tempMin)),
    tempMax: Math.max(...covered.map((w) => w.tempMax)),
    weatherLines: monthIndexes.map(
      (m) => `${MONTH_NAMES[m]} — ${dest.weather[m].summary}`,
    ),
    mode,
  };
}

/**
 * Computes the three quantities here and injects them as literals, so the model
 * copies numbers instead of doing arithmetic — the least reliable thing an LLM
 * does, and quantity scaling is a stated success criterion.
 *
 * The daily count caps at 7 because nobody packs 14 t-shirts for a 14-day trip;
 * the text says so, otherwise the model "corrects" the cap back to `days`.
 */
export function quantityGuide(days: number): string {
  const daily = Math.min(days, 7);
  const reuse = Math.min(Math.ceil(days / 2), 4);
  const single = 1;

  return [
    "Quantity guide. Copy these numbers; do not compute your own.",
    `- Items worn fresh every day (t-shirts, underwear, socks): qty ${daily}.`,
    `- Items worn more than once before washing (trousers, shirts, towels): qty ${reuse}.`,
    `- Everything worn or carried once (jacket, shoes, charger, documents): qty ${single}.`,
    `This trip is ${days} ${days === 1 ? "day" : "days"} long, and the daily number is capped at 7 however long the trip runs: beyond a week assume one laundry stop rather than one garment per day.`,
  ].join("\n");
}

/**
 * Domain *constraints*, never items. This is the load-bearing part of "a bike
 * list and a flight list genuinely differ": hand the model a list of bike gear
 * and it hands the list straight back under a new heading, whereas handing it
 * the physics makes it reason differently. Each brief is therefore written in
 * the vocabulary of its own mode — "pannier" belongs to the bike brief and
 * "cabin" to the flight brief, and a test asserts that exclusivity so the day
 * someone folds these into one template with the mode word swapped in, it fails.
 */
export const MODE_BRIEF: Record<TravelMode, string> = {
  bike:
    "There is no baggage hold and no overhead locker: everything either fits in " +
    "panniers or a tail bag, or it does not come. Whatever is packed will be " +
    "rained on at speed, so water getting in is a question of when rather than " +
    "whether. A mechanical failure is a roadside problem with no support and " +
    "often no signal, so the rider is their own recovery. Hands, knees, neck and " +
    "eyes are the exposed joints and take the grit, the sun and any impact. Wind " +
    "chill subtracts several degrees from the temperatures below once moving, so " +
    "the stated low is optimistic.",
  flight:
    "Liquids in containers over 100 ml cannot travel in the cabin at all. Power " +
    "banks above 100 Wh are refused outright, and sharp tools are restricted to " +
    "checked baggage. Checked baggage can arrive a day late or not at all, so one " +
    "day of essentials and every medication travel in the cabin bag rather than " +
    "in the hold. Total weight is capped and weighed at the counter, so bulk and " +
    "mass both cost money.",
  bus:
    "Luggage goes into a hold that cannot be opened mid-journey, so anything " +
    "needed en route has to live in one small bag kept at the seat. Overnight air " +
    "conditioning runs cold regardless of how warm the outside temperature is, " +
    "and the blanket, where there is one, is thin. Many operators have no " +
    "charging point at the seat, so power has to be carried aboard. Ghat roads " +
    "are hours of continuous switchbacks and motion sickness is common, including " +
    "for people who never get it elsewhere.",
};

/**
 * Rules only, never data — interpolating nothing is what keeps the system prompt
 * out of the cache-key conversation entirely.
 *
 * The "never name or refer to the traveller" rule is not politeness. `ai_cache`
 * is global and keyed on the trip tuple alone, so a personalised answer written
 * for one user would later be served verbatim to a stranger.
 */
const SYSTEM_PROMPT = [
  "You are an experienced travel-kit planner. You produce a checklist someone",
  "packs from tonight: specific, finite and complete, not a survey of everything",
  "that could conceivably be useful.",
  "",
  "Rules:",
  "- Return between 4 and 6 categories, each holding between 3 and 8 items.",
  "- Category names are drawn from Clothing, Gear, Documents and Health, plus",
  "  exactly one mode category whose title is the literal string given in the",
  "  user message. Reproduce that string character for character.",
  "- Fill in a reason only where the item is non-obvious: a temperature, a",
  "  terrain fact, a regulation, a distance from help. Obvious items get an empty",
  '  reason. "Because you need it" is not a reason.',
  "- Copy every quantity from the quantity guide in the user message. Do not",
  "  invent your own scaling.",
  "- No brand names, no shop names, no prices, no links.",
  "- Every claim must be traceable to the trip facts in the user message. Do not",
  "  invent weather, roads, altitudes or regulations that are not stated there.",
  "- Never name or refer to the traveller, and never mention who is asking.",
  "- Return only the structured object: no preamble, no markdown, no commentary.",
].join("\n");

export function packingSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * Renders the grounding facts. Deterministic for the same reasons
 * `buildGrounding` is, and interpolates `PackingGrounding` fields only.
 *
 * Deliberately excluded from `Destination`, because each one makes the answer
 * worse:
 * - `budgetTier` — packing does not vary with budget, and raising money invites
 *   exactly the brand and price talk the system prompt forbids.
 * - `monthScores` — a *fit* score, not weather. The model reads a bare "3" as a
 *   temperature or a rating and reasons from it.
 * - `coords` — invites invented altitude and latitude claims that no grounding
 *   fact supports.
 * - `blurb`, `bestFor`, `heroGradient` — marketing copy, and its tone bleeds
 *   straight into the summary.
 * - Anything at all originating from the user: no name, no email, no user id, no
 *   trip id. `PackingGrounding` carries none of it, so this is structural.
 */
export function packingUserPrompt(g: PackingGrounding): string {
  const documents = g.international
    ? "This is an international trip, so Documents must cover passport, visa, travel insurance, a plug adapter and local currency."
    : "This is a domestic trip, so Documents needs no passport, visa, plug adapter or foreign currency.";

  return [
    "Build a packing checklist for the trip below. These are the only facts you",
    "have; everything you write must trace back to one of them.",
    "",
    "DESTINATION",
    `Name: ${g.destinationName}`,
    `Region: ${g.region}`,
    `Country: ${g.country}`,
    documents,
    `Tags: ${g.tags.join(", ")}`,
    `Good for travelling by road: ${yesNo(g.roadTrip)}`,
    `Days this destination really needs: ${g.idealDays}`,
    "",
    "DATES",
    `Start: ${g.start}`,
    `End: ${g.end}`,
    `Length: ${g.days} ${g.days === 1 ? "day" : "days"}, counting both dates`,
    `Calendar months covered: ${g.months.join(", ")}`,
    "",
    "TYPICAL WEATHER FOR THOSE MONTHS",
    `Coldest low: ${g.tempMin} °C`,
    `Hottest high: ${g.tempMax} °C`,
    ...g.weatherLines,
    "",
    "TRAVEL MODE",
    `Travelling by: ${g.mode}`,
    MODE_BRIEF[g.mode],
    "",
    `Title the mode category exactly: ${MODE_CATEGORY_TITLE[g.mode]}`,
    "Do not place an item in the mode section that would appear unchanged in a list for a different travel mode. If an item belongs to every mode, it belongs in Clothing, Gear, Documents or Health.",
    "",
    quantityGuide(g.days),
  ].join("\n");
}
