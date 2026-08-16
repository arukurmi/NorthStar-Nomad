# PRD F2 — Packing List Generator

| | |
| --- | --- |
| **Status** | Delivered — `feat/f2-packing-list` |
| **Branch** | `feat/f2-packing-list` |
| **Depends on** | F0 |
| **Size** | Small |

## Summary

Generate a mode-aware, weather-aware packing checklist for a trip, saved and
tickable, so the user can actually pack from it.

## Problem

Northstar Nomad already knows more about what a user should pack than the user
does: the destination's exact month temperatures (`tempMin` / `tempMax`), the
trip length, the travel mode, and the terrain tags. It knows Jaisalmer nights
hit 10°C in November and that a bike trip needs rain liners and a tool kit.
None of that reaches the user. They pack from memory and get it wrong — cold
nights in the desert and wet gear on a monsoon ride are the two most common
ways a well-chosen trip still goes badly.

This is the highest value-per-token feature in the cluster: a small, cheap
call against data the app already holds.

## Users & jobs

- *The bike rider* needs gear, not clothes — gloves, rain liners, tool kit,
  spare cables — and forgets one every trip.
- *The 2-day flyer* wants a cabin-bag-only list.
- *The first-time high-altitude traveller* doesn't know what "cold desert"
  means in practice.

## Goals

1. Categorised list — Clothing, Gear, Documents, Health, Mode-specific.
2. Each item tickable, with state persisted per trip.
3. Quantities scaled to trip length ("3 × t-shirts" for a 3-day trip).
4. Mode-specific sections that are genuinely different, not cosmetic relabels.
5. Explicit reasons on non-obvious items ("thermals — nights drop to 4°C").

## Non-goals

- Shopping links or affiliate commerce
- Weight/volume optimisation
- Sharing lists between users
- Editing or adding custom items (v1 is generate + tick)

## Functional requirements

### Backend

**`POST /api/ai/packing`** — auth required, key required.

```jsonc
// request
{ "destinationId": "spiti", "start": "2026-06-12", "end": "2026-06-18",
  "mode": "bike", "tripId": 42 }
```

```jsonc
// response
{ "cached": false,
  "packing": {
    "summary": "Seven days, high-altitude cold desert, on a bike — layers and spares.",
    "categories": [
      { "name": "Mode — Bike",
        "items": [
          { "label": "Rain liners", "qty": 1,
            "reason": "June showers start at Kunzum; wet gear at 4000m is dangerous." }
        ] }
    ] }
}
```

Grounding: destination name/region/tags/`idealDays`, trip length in days, the
month's `tempMin`/`tempMax`/`summary`, the mode, and whether the destination
is international (drives the Documents section — passport, visa, adapters).

Prompt constraints: 4–6 categories; 3–8 items each; `reason` required only
where the item is non-obvious; quantities scale with trip length; no brand
names.

Cache key includes destinationId, start, end, mode, model.

**Tick state.** `POST /api/trips/:id/packing/check` with `{ itemKey, checked }`,
stored in a `trip_packing` table keyed by trip and a stable item key. Tick
state is per-user and never part of the shared cache payload.

### Frontend

A **Pack** tab beside F1's Plan tab in `DestinationDetail`, and a packing card
on the trip row in the profile page:

- Categories as collapsible sections, mode-specific one expanded by default.
- Checkboxes with an overall progress indicator ("11 / 24 packed").
- `reason` shown as quiet secondary text under the item, not a tooltip — it is
  the part that teaches.
- No key → `<KeyPrompt />`. Generating → skeleton rows.

## Success criteria

- A bike list and a flight list for the same destination and dates differ in
  more than labels — verified by fixture comparison.
- Tick state survives reload and is scoped to the user.
- A cold-destination list in winter contains thermals; a monsoon list contains
  rain protection. Fixture-reviewed.

## Test plan

- Route: happy path; bike vs flight produce different category sets; no key →
  428; unknown destination → 400; unauth → 401.
- Cache: identical inputs hit; differing mode misses.
- Tick: check/uncheck round trip; another user's trip → 404, not a leak.
- Quantity scaling: 2-day vs 7-day requests produce different quantities.
- Frontend: progress counter, collapsed/expanded states, empty-key state.

## Micro-task breakdown

1. ✅ Packing JSON schema + types — phase 01
2. ✅ `prompts/packing.ts` + snapshot test — phase 01, as committed `.txt`
   fixtures compared with `toBe` rather than `toMatchSnapshot()`. A `vitest -u`
   silently blessing a prompt regression is the one failure a prompt test must
   not have.
3. ✅ `POST /api/ai/packing` + tests — phase 02
4. ✅ `trip_packing` table + tick endpoint + tests — DDL in phase 01, endpoints
   in phase 03. Split because `db.ts` is a single `db.exec()` block and the
   endpoints need the store, which needs the parser.
5. ✅ Cache integration — **merged into task 3**, not shipped separately. A route
   that called a provider without consulting the cache would bill users for the
   duration of one PR, which violates cluster principle 5. Caching is not a
   follow-up to the route; it is the route.
6. ✅ `web` client methods — phase 04
7. ✅ Category / checklist components — phase 04
8. ✅ Pack tab wiring + progress indicator — phase 04
9. ✅ Profile trip-row packing card — phase 05
10. ✅ Mobile pass + docs — phase 05

Two additions the PRD did not list, both forced by the cluster's own rules:

- **The `ai_cache` decisions.** `docs/THREAT-MODEL.md` §5 required the first
  feature to write to that table to settle provider namespacing and the missing
  TTL. F2 is that feature. Both are recorded in the LLD §2 and the threat model.
- **A per-account throttle on the route.** The threat model accepted "spend the
  victim's provider credit through our features" as an F0 risk explicitly
  *because F1–F4 did not exist yet*. This route makes it real, so the acceptance
  lapsed with it.

## What shipped against the success criteria

- *A bike list and a flight list differ in more than labels* — enforced at the
  prompt, where `MODE_BRIEF` injects each mode's physics rather than a list of
  items, and asserted by a test that strips every mode word from both prompts
  and requires the remainders to still differ.
- *Tick state survives reload and is scoped to the user* — `trip_packing` holds
  the whole checklist, so `GET /api/trips/:id/packing` rehydrates it with no AI
  key, no provider call and no cache lookup, long after the cached row expires.
- *A cold-destination list contains thermals; a monsoon list contains rain
  protection* — grounded on `tempMin`/`tempMax` and the summary line for **every**
  month the trip touches, not the start month alone.

## Not delivered, and why

- **No web test runner.** This repo has none and F2 did not add one, so the
  frontend rests on `tsc --noEmit`, `vite build`, code review and a manual
  checklist. The rendered output and the 375px layout were reasoned about, not
  observed.
