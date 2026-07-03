# Northstar Nomad — Travel Calendar Design

**Date:** 2026-07-03
**Status:** Approved for implementation (user directed full autonomous build)

## What it is

A UI-heavy travel-calendar website. The home screen is a single calendar. Every
upcoming free window (weekends, long weekends, any custom date range the user
selects) is automatically populated with the best places to visit right then,
grouped by how you'd get there:

- ✈️ **Flight trip** — a far-away pick (domestic metro-hop or international)
- 🏍️ **Bike trip** — a ride-able destination within road-trip range
- 🚌 **Bus / friends trip** — a budget group-travel pick

Recommendations are weather-aware (each destination carries a month-by-month
climate profile) and split into **India** and **International** sections, with
a manual **refresh** that rotates through the ranked pool so the calendar is
never empty and never boring.

## Architecture

Monorepo, two packages:

```
northstar-nomad/
├── server/          Node 20 + Express + TypeScript
│   └── src/
│       ├── data/          hardcoded destination dataset + holidays
│       ├── engine/        scoring + recommendation engine
│       └── routes/        REST API
├── web/             React 18 + Vite + TypeScript + Tailwind CSS
│   └── src/
│       ├── components/    calendar, trip cards, panels
│       ├── hooks/         data fetching, state
│       └── lib/           date utils, api client
└── docs/            specs, plan, TWEETS.md
```

No database, no external APIs at runtime. Everything the engine needs is
hardcoded in `server/src/data/` (destinations researched from general
best-time-to-visit knowledge: Wikipedia/TripAdvisor-style seasonal guidance
baked into the dataset).

## Data model

**Destination** (`server/src/data/destinations.ts`):

- `id`, `name`, `region`, `country`
- `scope`: `"india" | "international"`
- `modes`: subset of `["flight", "bike", "bus"]` (which travel styles suit it)
- `homeBase`: recommendations assume a Delhi-NCR home base for bike/bus
  distance realism (configurable constant)
- `distanceKm`, `idealDays` (min trip length)
- `monthScores[12]`: 0–10 fit per calendar month (encodes weather: monsoon,
  snow, heat, peak season)
- `weather[12]`: short forecast-style blurb + temp range per month
- `budgetTier`: `"₹" | "₹₹" | "₹₹₹"`
- `tags` (e.g. beach, trek, heritage), `blurb`, `heroGradient` (CSS gradient —
  no external images), `bestFor`

**Holidays** (`server/src/data/holidays.ts`): Indian public holidays for
2026–2027, used to detect long weekends.

## Recommendation engine

`recommend(dateRange, options)`:

1. Compute trip length and the covered month(s).
2. Score every destination: `monthScore` (weighted across covered months)
   + mode suitability + trip-length fit (`idealDays` vs available days)
   − small distance penalty for short trips.
3. Return, for the range: top **3 ranked options per mode** (flight / bike /
   bus) for India, plus top 3 **international** (flight) picks.
4. `refreshSeed` param rotates the returned pick within each ranked pool, so
   "refresh" deterministically cycles alternatives without randomness bugs.

## API

- `GET /api/health`
- `GET /api/calendar/:year/:month` — day grid metadata: weekends, holidays,
  long-weekend spans, per-weekend teaser (best single pick)
- `GET /api/recommendations?start&end&seed=n` — full mode-grouped picks
- `GET /api/destinations/:id` — detail (full weather table, tags, blurb)

## UI (frontend-design skill drives the aesthetic)

- **Calendar canvas**: month grid, large and central. Weekends glow; long
  weekends get a connected highlight band with a badge ("3-day weekend").
  Month navigation + a "next free weekend" jump button.
- **Trip drawer**: clicking a weekend/range slides in a panel with three mode
  columns (Flight / Bike / Bus), each a destination card: gradient hero,
  weather chip for those exact dates, budget tier, why-now line. India /
  International toggle. Per-mode ↻ refresh.
- **Destination detail**: expandable card view with 12-month weather strip.
- Distinctive visual direction per the frontend-design skill (custom type
  scale, gradient identity, motion on drawer + refresh).

## Error handling

- Server validates date params (400 with message on bad input).
- Web shows skeleton loaders and a friendly retry state if the API is down.
- Engine always returns something: if no destination scores well, fall back to
  best-available with an honest "shoulder season" note.

## Testing

- Vitest on the server: engine scoring, long-weekend detection, seed rotation.
- Light component sanity tests are optional; verification is primarily by
  running the app (`/verify`-style manual check per phase).

## Process constraints (user-directed)

- 20–30 small phases, built bottom-up; **every phase ends in a commit** with a
  clear message. No uncommitted phases.
- Fixes to earlier phases discovered later are done on a separate
  `fix/<topic>` branch, merged to main, then the next phase resumes.
- `docs/TWEETS.md`: 2-day Twitter calendar (Day 1: idea/teaser, 4–5 tweets;
  Day 2: build story — features, stack, AI agents used).
