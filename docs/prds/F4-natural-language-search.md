# PRD F4 — Natural-Language Trip Search

| | |
| --- | --- |
| **Status** | Awaiting approval |
| **Branch** | `feat/f4-nl-search` |
| **Depends on** | F0 |
| **Size** | Medium |

## Summary

A search bar that accepts *"somewhere cold, under ₹8k, riding distance, next
long weekend"* and answers it — by translating language into the existing
engine's filters, not by asking a model to name destinations.

## Problem

The app's filters are good and its expressiveness is bad. A user can pick a
budget tier, up to seven vibes, a home city, and a date range — but only by
operating four separate controls, and only within the vocabulary those
controls happen to expose. "Riding distance" is not a chip. "Next long
weekend" is a date range the user has to go find on the calendar themselves.
"Cold" maps to no vibe at all.

Meanwhile the calendar already knows where the long weekends are, and the
engine already knows every destination's distance and month temperatures. The
missing piece is the translation layer between how people describe a trip and
how the engine represents one.

This is the only feature in the cluster where AI makes the *existing* engine
more powerful rather than adding a panel beside it.

## The core design decision

**The model chooses filters. The engine chooses destinations.**

The model's entire output is a constrained filter object — the same shape
`/api/recommendations` already accepts. It never sees the destination list and
never names a place. This means:

- Zero hallucinated destinations, structurally rather than by instruction.
- Results stay explainable — the UI can show exactly what it understood.
- Ranking stays deterministic and testable.
- The cheapest possible call: a small input and a tiny structured output.

## Users & jobs

- *The vague planner* knows the feeling they want, not the place or the date.
- *The constrained searcher* has hard limits — budget, distance, days — and
  wants them all applied at once.
- *The returning user* wants to skip four controls and type one sentence.

## Goals

1. Parse free text into `{ start, end, cityId, budget, vibes[], maxDistanceKm,
   modes[], scope }`.
2. Resolve relative dates against the real calendar — "next long weekend"
   uses the existing holiday data, not the model's guess.
3. Show the interpretation back to the user as editable chips.
4. Fall back gracefully: unparseable terms are dropped and named, never
   silently ignored.
5. Reuse `recommend()` unchanged — no second ranking path.

## Non-goals

- Conversational follow-up ("no, colder") — v1 is one-shot, re-edit via chips
- Free-text destination lookup ("tell me about Hampi")
- Searching outside the versioned dataset
- Voice input

## Functional requirements

### Backend

**`POST /api/ai/search`** — auth required, key required.

```jsonc
// request
{ "query": "somewhere cold under 8k, riding distance, next long weekend",
  "cityId": "delhi", "today": "2026-08-14" }
```

```jsonc
// response
{ "cached": false,
  "interpretation": {
    "dates": { "start": "2026-10-02", "end": "2026-10-05",
               "reason": "Next long weekend — Gandhi Jayanti falls on a Friday." },
    "budget": "₹",
    "vibes": ["mountains"],
    "maxDistanceKm": 600,
    "modes": ["bike"],
    "scope": "india",
    "unresolved": []
  },
  "results": { /* exactly the /api/recommendations shape */ } }
```

**Constrained output.** The schema enumerates only real values: `budget` is
one of `₹ / ₹₹ / ₹₹₹`; `vibes` are keys of the existing `VIBES` map; `modes`
are `flight | bike | bus`; `scope` is `india | international`. Any value
outside the enum is dropped and reported in `unresolved`, never passed on.

**Dates are resolved in code, not by the model.** The model emits a date
*intent* — `next_weekend`, `next_long_weekend`, `specific_range`,
`month(october)`, `days(3)` — and the server resolves it against the existing
holiday and weekend data. The model is never trusted with what date it is.

**`maxDistanceKm` is a new engine option.** It requires a small, additive
change to `RecommendOptions` and a filter in `recommend()` — the only backend
change outside the AI layer in this cluster. It is independently useful and
should be tested as its own unit.

**Rate limiting.** A search bar invites repeat submissions in a way the other
features do not. Per-user limit of 20 searches per hour, returning `429` with
`retryAfter`. Identical queries within a session hit cache and do not count.

Cache key: `sha256("search|" + normalisedQuery + cityId + today + model)`.

### Frontend

A search bar on the calendar page, in the header area:

- Placeholder rotates through real examples so the capability is discoverable
  without a tutorial.
- On submit: bar enters a loading state; on success the trip drawer opens with
  results.
- **The interpretation is shown as editable chips** above the results —
  `❄️ mountains` `₹ under 8k` `🏍️ ≤600km` `Oct 2–5`. Removing a chip re-runs
  the search through the plain engine, no AI call. This is what makes the
  feature trustworthy rather than magic.
- `unresolved` terms shown quietly: *"I didn't understand 'pet friendly'."*
- Zero results → the existing honest empty state, plus which chip to try
  removing.
- No key → the bar is visible but disabled with `<KeyPrompt />` on click. The
  existing filter chips keep working exactly as they do today.

## Success criteria

- No response ever contains a destination not in the dataset. Structural.
- "Next long weekend" resolves to the same dates the calendar highlights —
  asserted against the holiday data.
- Removing a chip costs zero AI calls.
- Existing filter chips and `/api/recommendations` behaviour are unchanged for
  users without a key.
- Median search returns in under 3 seconds.

## Test plan

- Parsing: a fixture table of ~15 real queries → expected filter objects,
  run against `fake.ts`.
- Enum safety: a fake response containing `vibes: ["skiing"]` and
  `budget: "$$$$"` drops both and populates `unresolved`.
- Date resolution: `next_long_weekend` from several "today" values matches the
  holiday data; never returns a past date.
- `maxDistanceKm`: unit tests on `recommend()` independent of AI.
- Rate limit: 21st search in an hour → 429; cached repeats don't count.
- Route: no key → 428; empty query → 400; unauth → 401.
- Frontend: chip removal re-runs without an AI call (asserted by request spy).

## Micro-task breakdown

1. `maxDistanceKm` in `RecommendOptions` + `recommend()` + tests *(no AI)*
2. Search interpretation schema + types
3. Date-intent resolver against holiday data + tests *(no AI)*
4. `prompts/search.ts` + snapshot test
5. Enum sanitiser + `unresolved` reporting + tests
6. `POST /api/ai/search` route + tests
7. Per-user rate limiter + tests
8. Cache integration
9. `web` client method
10. Search bar component + rotating placeholder
11. Interpretation chips + removal re-run path
12. Drawer wiring, empty states, mobile pass + docs
