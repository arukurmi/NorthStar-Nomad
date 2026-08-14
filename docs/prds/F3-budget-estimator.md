# PRD F3 — Budget Estimator & Friends Split

| | |
| --- | --- |
| **Status** | Awaiting approval |
| **Branch** | `feat/f3-budget-estimator` |
| **Depends on** | F0 |
| **Size** | Medium |

## Summary

Turn the abstract `₹ / ₹₹ / ₹₹₹` tier into an itemised estimate — transport,
stay, food, activities, buffer — with a per-head split for group bus trips.

## Problem

`budgetTier` is the single least useful field the app shows. "₹₹" tells a user
nothing they can plan against. Money is the most common reason a chosen trip
does not happen, and it is the question the current UI answers worst: the
filter chip lets you *filter* by budget but never tells you what a trip
actually costs.

The bus mode makes this sharper. Bus trips are group trips by design — three
friends splitting a Manali weekend need a per-head number, and that number is
the thing that gets a group to commit in the chat thread.

## Users & jobs

- *The budget-constrained traveller* wants to know if ₹8,000 is enough before
  investing more thought.
- *The group organiser* needs a per-head figure to post in the group chat.
- *The comparer* wants two candidate destinations priced side by side.

## Goals

1. Itemised estimate across transport / stay / food / activities / buffer.
2. A range per line, not false precision — `₹2,400–3,800`, never `₹2,847`.
3. Scaled to real inputs: distance from home city, trip length, mode, tier.
4. Friends-split view with an adjustable group size for bus mode.
5. Honest framing that these are estimates, with the assumptions listed.

## Non-goals

- Live fare or hotel-price lookups (that is the separate live-data cluster)
- Booking or payments
- Currency conversion beyond a single display currency (INR)
- Expense tracking during the trip

## Functional requirements

### Backend

**`POST /api/ai/budget`** — auth required, key required.

```jsonc
// request
{ "destinationId": "manali", "start": "2026-10-02", "end": "2026-10-05",
  "mode": "bus", "groupSize": 4, "tier": "₹₹" }
```

```jsonc
// response
{ "cached": false,
  "budget": {
    "currency": "INR",
    "perPerson": { "low": 6200, "high": 9400 },
    "lines": [
      { "category": "transport", "label": "Delhi → Manali return, sleeper bus",
        "low": 1800, "high": 2600,
        "basis": "540km each way, overnight Volvo, festival-week pricing" }
    ],
    "assumptions": ["Shared twin room", "Two paid activities", "October rates"],
    "split": { "groupSize": 4, "sharedTotal": 12000, "perHead": 3000 }
  }
}
```

Grounding: destination name/region/country/`budgetTier`/tags, road distance
from the user's home city (from the existing `roadDistanceKm`), trip length,
mode, month, requested tier, and group size. The prompt is explicit that these
are planning estimates for the stated month and must state their basis.

Prompt constraints: every line needs a `basis`; ranges only; a buffer line is
mandatory; `perPerson` must be internally consistent with the line items —
validated server-side, and a mismatch beyond 10% triggers the repair retry.

`split` is present only when `mode === "bus"` and `groupSize > 1`. Shared
costs (transport hire, room) divide; personal costs (food, activities) do not.

Cache key includes destinationId, start, end, mode, tier, groupSize, model.

### Frontend

A **Budget** tab in `DestinationDetail`:

- A headline per-person range in display type, the number the user came for.
- Line-item table; `basis` revealed on row expand, so the default view stays
  scannable.
- Assumptions listed plainly beneath, not hidden behind an info icon.
- Bus mode: a group-size stepper (2–8) that re-requests on change; per-head
  figure updates as the hero number.
- A visible "estimates, not quotes" line. This is a trust feature; burying the
  disclaimer would be the wrong call.
- No key → `<KeyPrompt />`. Generating → skeleton table rows.

Optionally surfaced as a compact range badge on `DestinationCard` once a
budget has been generated and cached — no extra call.

## Success criteria

- Line items sum consistently with the headline range (validated, not hoped).
- A 300km bus trip and a 2,000km flight produce visibly different transport
  lines.
- Group-size change updates per-head without a full regeneration when the
  underlying estimate is cached.
- Every line has a stated basis.

## Test plan

- Route: happy path; `split` absent for flight/bike; present for bus with
  `groupSize > 1`; no key → 428; bad `groupSize` → 400; unauth → 401.
- Consistency: a fake response whose lines contradict `perPerson` by >10%
  triggers one repair retry, then `bad_output`.
- Cache: identical inputs hit; differing tier or groupSize misses.
- Distance sensitivity: near vs far destinations yield different transport
  ranges.
- Frontend: stepper behaviour, row expansion, disclaimer always rendered.

## Micro-task breakdown

1. Budget JSON schema + types
2. `prompts/budget.ts` + grounding builder + snapshot test
3. Consistency validator (lines vs headline) + tests
4. `POST /api/ai/budget` + tests
5. Split calculation + tests
6. Cache integration
7. `web` client methods
8. Budget table + skeleton components
9. Group-size stepper + Budget tab wiring
10. `DestinationCard` range badge + mobile pass + docs
