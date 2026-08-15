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

## Environment

Development needs none of these — every one has a working default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOMAD_MASTER_KEY` | built-in dev key; **required in production** | Encrypts each user's AI API key at rest (AES-256-GCM). Must decode, as base64 or hex, to at least 32 bytes. |
| `NOMAD_DB` | `data.sqlite` (`:memory:` under `NODE_ENV=test`) | Path to the SQLite file. |
| `JWT_SECRET` | built-in dev secret; **required in production** | Signs session tokens. At least 32 characters, and never the built-in value. |
| `NOMAD_WEB_ORIGIN` | none in production, permissive in development | Comma-separated origins allowed to call the API cross-origin. |
| `PORT` | `4000` | Port the API listens on. |

**`NOMAD_MASTER_KEY` and `JWT_SECRET` are hard requirements in production.**
Missing, too weak, or containing the built-in development value, the server
writes an explanation to stderr and exits 1 before binding a port, rather than
accepting API keys it can only store badly or sessions anyone could forge.
Generate each with:

```bash
openssl rand -base64 48
```

Strength is measured in decoded bytes, not characters: `"a"` repeated 32 times
is 32 characters and one byte of entropy, and is rejected.

Outside production both fall back to values that are committed to this repo, and
the master key prints a warning saying so. Anything encrypted under that key is
readable by anyone who can clone this project, which is why production refuses
it — as does any host carrying a platform marker such as `RENDER` or
`K_SERVICE`, even if `NODE_ENV` was never set.

## Stack

- **server/** — Node 20, Express, TypeScript. SQLite via better-sqlite3 (WAL)
  for accounts, trips, and encrypted AI keys; the destination dataset,
  holidays, and scoring engine are versioned in git rather than seeded into a
  table. Vitest + supertest.
- **web/** — React 18, Vite, Tailwind. No images: every destination hero is a
  CSS gradient. Night-sky design system (Bricolage Grotesque / Instrument
  Sans / Space Grotesk).

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/calendar/:year/:month` | Day grid, holidays, long weekends, weekend teasers |
| `GET /api/recommendations?start&end&seed` | Mode-grouped picks for a date range |
| `GET /api/destinations/:id` | Full destination detail |
| `POST /api/ai/keys` | Validate an AI API key with its provider, then store it encrypted |
| `GET /api/ai/keys` | List configured providers — last 4 characters only, never the key |
| `PUT /api/ai/keys/preferred` | Choose which provider AI features use by default |
| `DELETE /api/ai/keys/:provider` | Remove a stored key |
| `GET /api/ai/usage` | Per-feature calls and tokens, with cached calls counted separately |

AI keys are yours: you add your own Anthropic, Gemini or OpenAI key under
**Profile → AI & Keys**, you pay that provider directly, and the key is
encrypted with AES-256-GCM before it reaches the database. It is decrypted in
memory only to make a request you asked for, and never appears in a response, a
log, or a URL.

## Docs

- `docs/superpowers/specs/` — design spec
- `docs/superpowers/plans/` — the 22-phase implementation plan (one commit per phase)
- `docs/TWEETS.md` — 2-day build-in-public Twitter calendar
- `docs/AI-ROADMAP.md` — AI integration & travel-assistant feature roadmap

Built with Claude Code (Fable 5) using the brainstorming, writing-plans, and
frontend-design skills — 22 phases, each ending in a clean commit.
