# Northstar Nomad 🧭

A weather-aware travel calendar. Open it, see your free weekends glowing like
stars, click one — and get the best places to go right then: one by ✈️ flight,
one by 🏍️ bike, one by 🚌 bus with friends. India and international.

## Features

- **Constellation calendar** — weekends glow; long weekends (from Indian
  public holidays 2026–27) form connected bands with day-count badges and a
  best-pick teaser on every Saturday.
- **Trip drawer** — click any day/weekend and a panel slides in with three
  travel-mode picks scored for those exact dates.
- **Weather-aware engine** — 30+ destinations, each with a 12-month climate
  profile. Goa scores 2/10 in July and 10/10 in December; the engine knows.
- **Smart scoring** — weather fit × trip-length fit − distance penalty. A
  2-day weekend never suggests Ladakh; a week off does.
- **↻ Refresh rotation** — every mode has a ranked pool; refresh cycles
  alternatives deterministically, so picks are never empty and never random.
- **Destination detail** — 12-month when-to-go strip with your dates
  highlighted, forecast-style weather for the trip, budget tier, tags.
- **India ⇄ International** toggle, shoulder-season honesty note, skeleton
  loaders, keyboard navigation (←/→ months, Esc closes the drawer).

## Run it

```bash
npm install
npm run dev        # API on :4000 + web on :5173, both in watch mode
```

Open http://localhost:5173. Backend and frontend live in separate folders
(`server/` and `web/`); `npm run dev:server` / `npm run dev:web` run them
individually.

## Stack

- **server/** — Node 20, Express, TypeScript. No database: the destination
  dataset, holidays, and scoring engine are all versioned in git. Vitest +
  supertest (60 tests).
- **web/** — React 18, Vite, Tailwind. No images: every destination hero is a
  CSS gradient. Night-sky design system (Bricolage Grotesque / Instrument
  Sans / Space Grotesk).

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/calendar/:year/:month` | Day grid, holidays, long weekends, weekend teasers |
| `GET /api/recommendations?start&end&seed` | Mode-grouped picks for a date range |
| `GET /api/destinations/:id` | Full destination detail |

## Docs

- `docs/superpowers/specs/` — design spec
- `docs/superpowers/plans/` — the 22-phase implementation plan (one commit per phase)
- `docs/TWEETS.md` — 2-day build-in-public Twitter calendar
- `docs/AI-ROADMAP.md` — AI integration & travel-assistant feature roadmap

Built with Claude Code (Fable 5) using the brainstorming, writing-plans, and
frontend-design skills — 22 phases, each ending in a clean commit.
