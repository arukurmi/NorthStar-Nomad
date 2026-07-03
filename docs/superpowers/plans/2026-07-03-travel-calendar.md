# Northstar Nomad Travel Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A UI-heavy travel-calendar website that auto-populates every free weekend/date range with the best flight, bike, and bus destinations (India + international), weather-aware, with manual refresh.

**Architecture:** Monorepo with `server/` (Express + TS, hardcoded dataset + scoring engine) and `web/` (React + Vite + TS + Tailwind calendar UI). No DB, no external runtime APIs. Spec: `docs/superpowers/specs/2026-07-03-travel-calendar-design.md`.

**Tech Stack:** Node 20, Express 4, TypeScript 5, Vitest, React 18, Vite 5, Tailwind CSS 3.

## Global Constraints

- Every phase ends in a git commit with a clear conventional-commit message. **No phase left uncommitted.**
- A fix to an earlier phase discovered during a later phase goes on a `fix/<topic>` branch, merged to `main`, before the next phase starts.
- Home base for bike/bus distance realism: Delhi-NCR (constant `HOME_BASE` in `server/src/data/constants.ts`).
- Refresh is deterministic: `seed` cycles picks within each ranked pool (`pool[(rank0 + seed) % pool.length]`).
- Engine always returns picks (fallback to best-available with `shoulderSeason: true`).
- No external images: destination heroes are CSS gradients (`heroGradient`).

---

### Phase 1: Monorepo scaffold
Create: root `package.json` (npm workspaces `server`, `web`; scripts `dev`, `test`), `.gitignore` (node_modules, dist, .env), `README.md` rewrite (project name + one-liner).
Commit: `chore: scaffold npm workspaces monorepo`

### Phase 2: Server scaffold + health endpoint
Create: `server/package.json` (express, cors; dev: tsx, typescript, vitest, @types/*), `server/tsconfig.json`, `server/src/index.ts` (listen :4000), `server/src/app.ts` (exports `createApp(): Express` with `GET /api/health → {ok:true}`), test `server/src/app.test.ts` via supertest.
Produces: `createApp()` used by all later route phases; app/server split so tests don't bind ports.
Commit: `feat(server): express scaffold with health endpoint`

### Phase 3: Domain types + constants
Create: `server/src/types.ts` — `TravelMode = "flight"|"bike"|"bus"`, `Scope = "india"|"international"`, `MonthWeather {tempMin,tempMax,summary}`, `Destination {id,name,region,country,scope,modes,distanceKm,idealDays,monthScores:number[],weather:MonthWeather[],budgetTier,tags,blurb,heroGradient,bestFor}`; `server/src/data/constants.ts` (`HOME_BASE = "Delhi-NCR"`).
Commit: `feat(server): destination domain types`

### Phase 4: Indian destinations dataset
Create: `server/src/data/destinations-india.ts` — ~20 `Destination` entries spanning modes/seasons (e.g. Goa, Rishikesh, Jaipur, Manali, Spiti, Ladakh, Jim Corbett, Udaipur, Varanasi, Amritsar, Kasol, Lansdowne, Neemrana, Agra, Munnar, Andamans, Coorg, Darjeeling, Mcleodganj, Jaisalmer) with honest month scores (monsoon lows, winter peaks) and per-month weather blurbs. Test: dataset invariants (12 monthScores, 12 weather entries, non-empty modes, unique ids).
Commit: `feat(data): indian destinations dataset with monthly weather profiles`

### Phase 5: International destinations dataset
Create: `server/src/data/destinations-international.ts` — ~12 entries (e.g. Bali, Dubai, Singapore, Thailand/Krabi, Vietnam/Da Nang, Sri Lanka, Nepal/Pokhara, Bhutan, Georgia/Tbilisi, Azerbaijan/Baku, Maldives, Turkey/Istanbul), all `modes:["flight"]`, `scope:"international"`. Extend invariant test to combined `allDestinations` export in `server/src/data/index.ts`.
Commit: `feat(data): international destinations dataset`

### Phase 6: Holidays + long-weekend detection
Create: `server/src/data/holidays.ts` (Indian public holidays 2026–2027 as `{date,name}`), `server/src/engine/weekends.ts` — `findLongWeekends(year,month): {start,end,days,label,holidayName?}[]` (Sat–Sun default; holiday-adjacent 3–4 day spans). Tests: known 2026 long weekends, plain weekends.
Produces: used by calendar route (Phase 9).
Commit: `feat(engine): holiday data and long-weekend detection`

### Phase 7: Scoring engine
Create: `server/src/engine/score.ts` — `scoreDestination(dest, start: Date, end: Date): number` = weighted month fit across covered months + trip-length fit vs `idealDays` − distance penalty for short trips. Tests: monsoon Goa scores below winter Goa; 2-day trip penalizes Ladakh; deterministic.
Produces: `scoreDestination` for Phase 8.
Commit: `feat(engine): weather- and duration-aware destination scoring`

### Phase 8: Recommendation engine + seed rotation
Create: `server/src/engine/recommend.ts` — `recommend(start,end,seed=0): {india: Record<TravelMode, Pick[]>, international: Pick[], shoulderSeason: boolean}` where `Pick = {destination, score, whyNow, weatherNow}`; top-3 pools per mode, seed rotates pick order. Tests: 3 modes populated, seed rotation cycles, never empty.
Commit: `feat(engine): mode-grouped recommendations with refresh seed rotation`

### Phase 9: Calendar month API
Create: `server/src/routes/calendar.ts` — `GET /api/calendar/:year/:month` → `{days:[{date,isWeekend,holiday?}], longWeekends, teasers:{[startDate]: {name,mode,emoji}}}`. Validate params (400). Wire into `app.ts`. Supertest coverage.
Commit: `feat(api): calendar month endpoint with weekends, holidays, teasers`

### Phase 10: Recommendations + destination APIs
Create: `server/src/routes/recommendations.ts` — `GET /api/recommendations?start&end&seed` (400 on bad dates), `GET /api/destinations/:id` (404 unknown). Wire into `app.ts`. Supertest coverage.
Commit: `feat(api): recommendations and destination detail endpoints`

### Phase 11: Web scaffold
Create: `web/` via Vite react-ts template (checked in manually: package.json, vite.config.ts with `/api` proxy → :4000, tsconfig, index.html, src/main.tsx, src/App.tsx placeholder), Tailwind 3 setup (postcss, tailwind.config.js), `web/src/lib/api.ts` (typed fetch helpers mirroring server response types in `web/src/lib/types.ts`).
Commit: `feat(web): vite react tailwind scaffold with api client`

### Phase 12: Design system (frontend-design skill)
Invoke frontend-design skill for direction first. Create: `web/src/styles/` tokens — font pairing (display + body via fontsource or system stack), color palette, gradient set, spacing/radius scale in `tailwind.config.js` + `index.css`. App shell: header with wordmark + tagline.
Commit: `feat(web): design system tokens and app shell`

### Phase 13: Calendar grid (static)
Create: `web/src/components/Calendar/MonthGrid.tsx` + `web/src/lib/dates.ts` (month matrix builder, tested mentally via storybook-less render). Renders current month, weekday headers, today ring.
Commit: `feat(web): static month grid calendar`

### Phase 14: Calendar data wiring
Wire `GET /api/calendar` into grid via `web/src/hooks/useCalendarMonth.ts`: weekend glow, holiday dots + names, long-weekend connected band with day-count badge, weekend teaser chips.
Commit: `feat(web): live calendar with weekends, holidays, long-weekend bands`

### Phase 15: Navigation + next-free-weekend jump
Month prev/next controls, keyboard arrows, "Next free weekend →" button that scrolls/selects the upcoming weekend (computed client-side from calendar data).
Commit: `feat(web): month navigation and next-free-weekend jump`

### Phase 16: Trip drawer shell
Create: `web/src/components/TripDrawer/TripDrawer.tsx` — slide-in panel on weekend/day-range click (click day = weekend containing it or single day; long-weekend band click = full span). Shows selected range header + close. Selection state in `App.tsx`.
Commit: `feat(web): trip drawer opens on date range selection`

### Phase 17: Destination cards
Create: `web/src/components/TripDrawer/DestinationCard.tsx` — gradient hero, name/region, weather-now chip (temps + summary for selected dates), budget tier, why-now line, tags.
Commit: `feat(web): destination cards with weather chips`

### Phase 18: Mode columns + scope toggle
Drawer body: three columns Flight ✈️ / Bike 🏍️ / Bus 🚌 fed by `GET /api/recommendations` (`web/src/hooks/useRecommendations.ts`); India ⇄ International segmented toggle (international shows flight picks full-width).
Commit: `feat(web): mode columns with india/international toggle`

### Phase 19: Refresh rotation
Per-mode ↻ button increments that mode's seed (state per mode), card swaps with a flip/fade transition; global "shuffle all" in drawer header.
Commit: `feat(web): per-mode refresh rotation`

### Phase 20: Destination detail view
Card click expands to detail: 12-month weather strip (mini bar per month colored by score, current months highlighted), full blurb, best-for, ideal days. Uses `GET /api/destinations/:id`.
Commit: `feat(web): destination detail with 12-month weather strip`

### Phase 21: Polish — skeletons, errors, motion
Skeleton loaders for grid + drawer, friendly retry state when API down, drawer/refresh micro-motion, responsive pass (mobile: drawer becomes bottom sheet, columns stack), empty/shoulder-season note rendering.
Commit: `feat(web): loading, error, motion, and responsive polish`

### Phase 22: Docs + tweets + final verify
Create: `docs/TWEETS.md` (Day 1: 5 idea/teaser tweets; Day 2: build-story tweets — features, stack, AI agents used), README (features, screenshots section, run instructions: `npm install && npm run dev`). Final end-to-end verify (server tests green, both apps boot, manual flow).
Commit: `docs: readme and two-day twitter calendar`

## Self-review notes

- Spec coverage: calendar UI (13–15), drawer + 3 modes (16–18), India/international (5, 18), weather-aware (4–7, 17, 20), refresh (8, 19), always populated/fallback (8), holidays/long weekends (6, 14), tweets (22). ✔
- Interfaces named consistently: `createApp`, `scoreDestination`, `recommend`, `findLongWeekends`, route paths. ✔
