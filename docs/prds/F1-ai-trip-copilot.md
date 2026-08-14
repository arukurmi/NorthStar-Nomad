# PRD F1 — AI Trip Copilot (Day-by-Day Itinerary)

| | |
| --- | --- |
| **Status** | Awaiting approval |
| **Branch** | `feat/f1-ai-trip-copilot` |
| **Depends on** | F0 |
| **Size** | Medium |

## Summary

For any destination pick, generate a day-by-day itinerary sized to the exact
date range, ordered to minimise backtracking, grounded in that destination's
real climate profile and the user's travel mode.

## Problem

This is the dead-end. A user clicks Sat–Mon in November, sees "Jaisalmer,
9/10, peak season — clear desert days, cold nights", and then has nowhere to
go. The app has told them *where* and *why now* and stops exactly where the
work begins. Every user at this moment opens a new tab and searches
"jaisalmer 2 day itinerary" — that search is the feature we are missing.

The current `DestinationDetail` panel shows a 12-month weather strip and a
blurb. It is a reference card, not a plan.

## Users & jobs

- *The weekend rider* has Sat 6am to Sun 9pm and needs to know what actually
  fits, including ride time in daylight.
- *The flight traveller* lands at 11am Saturday and wants the first day to
  start from the airport, not from an abstract "Day 1".
- *The over-planner* wants something to edit rather than a blank page.

## Goals

1. An itinerary whose day count exactly matches the selected range.
2. Ordering that respects geography — no crossing the city twice.
3. Mode-awareness: bike itineraries budget riding time and daylight; bus
   itineraries assume overnight travel on the edges.
4. Grounded in the destination's `monthScores` and `weather` for those exact
   dates — a monsoon itinerary should not be full of open-air activities.
5. Attach the itinerary to a saved trip so it survives a reload.

## Non-goals

- Real-time opening hours, ticket prices, or bookings
- Map rendering or turn-by-turn routing
- Multi-destination / multi-city trips
- Editing individual items (v1 is regenerate-only)

## Functional requirements

### Backend

**`POST /api/ai/itinerary`** — auth required, key required.

```jsonc
// request
{ "destinationId": "jaisalmer", "start": "2026-11-14", "end": "2026-11-16",
  "mode": "flight", "tripId": 42 }   // tripId optional
```

Response, validated against a schema:

```jsonc
{
  "cached": false,
  "itinerary": {
    "summary": "Two desert days and a dune night, paced for a Saturday flight in.",
    "days": [
      { "date": "2026-11-14", "label": "Day 1 — Arrive & the old city",
        "blocks": [
          { "time": "morning", "title": "Land & drop bags",
            "detail": "…", "durationMins": 90 }
        ],
        "weatherNote": "Clear, 28°C high — the fort is exposed, go before noon." }
    ],
    "packingHint": "Nights drop to 10°C.",
    "caveats": ["Dune camps are 40km out — confirm pickup before dark."]
  }
}
```

Grounding injected into the prompt: destination `name`, `region`, `country`,
`tags`, `bestFor`, `blurb`, `idealDays`, `budgetTier`, the `monthScores` entry
and `weather` entry for the trip's month, the exact dates with weekday names,
the travel mode, and the road distance from the user's home city.

Constraints stated in the prompt: exactly N days; each day 3–5 blocks;
first day starts at arrival, last day ends before departure; no restaurant or
hotel names invented as fact; `caveats` used for anything uncertain.

Cache key: `sha256("itinerary|" + destinationId + start + end + mode + model)`.
No user identity in the key or the prompt.

Errors follow the F0 taxonomy. `bad_output` retries once with a repair
instruction before failing.

### Frontend

A **Plan** tab in the existing `DestinationDetail` panel:

- No key → `<KeyPrompt />` explaining what an itinerary would give them.
- Key, not yet generated → a "Generate itinerary" button with an honest cost
  note ("one call on your key, ~2000 tokens").
- Generating → skeleton day cards matching the real layout, not a spinner.
- Generated → vertical day cards, each with its label, weather note, and
  time-blocked rows. Caveats in a distinct, quieter treatment.
- Regenerate button; cached results load instantly and are labelled as cached.
- If a `tripId` exists, the itinerary persists and reopens with the trip.

Must match the existing night-sky design system — Bricolage Grotesque for
headings, CSS-gradient surfaces, no images, existing surface tokens.

## Success criteria

- Day count always equals the selected range length. Zero tolerance.
- A Ladakh itinerary in January reflects that passes are shut; a Goa
  itinerary in July reflects monsoon. Verified by fixture review.
- Second identical request returns `cached: true` and bills nothing.
- Panel renders correctly at 375px width.

## Test plan

- Route: happy path against `fake.ts`; day count matches range for 1, 2, 3,
  and 7-day spans; unknown `destinationId` → 400; no key → 428; unauth → 401.
- Cache: second identical call hits cache, differing `mode` does not.
- Schema: a malformed model response triggers exactly one repair retry, then
  `bad_output`.
- Prompt: a snapshot test asserting grounding data is present and no user
  identifier is.
- Frontend: renders each state; `<KeyPrompt />` shows when unconfigured.

## Micro-task breakdown

1. Itinerary JSON schema + types
2. `prompts/itinerary.ts` with grounding builder + snapshot test
3. `POST /api/ai/itinerary` route + tests
4. Cache integration + tests
5. Persist itinerary against `trips` (nullable `itinerary_json` column)
6. `web` API client method + types
7. Day-card components + skeletons
8. Plan tab wiring in `DestinationDetail`
9. Regenerate + cached-badge UX
10. Mobile pass + docs
