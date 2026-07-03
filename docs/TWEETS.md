# Northstar Nomad — 2-Day Twitter Calendar

Posting cadence assumes Twitter Premium (no length limits). Suggested times in IST.

---

## Day 1 — The idea (tease, problem, vision)

**Tweet 1 · 9:30 AM — the hook**

> Every Sunday night I realise the weekend just… evaporated.
>
> So I'm building something for my future self: a calendar that already knows my next free weekend — and tells me the 3 best places to go. One by flight ✈️, one by bike 🏍️, one by bus with friends 🚌.
>
> Building it in public. 🧵

**Tweet 2 · 11:30 AM — the problem**

> The real reason weekend trips don't happen isn't money or time.
>
> It's decision fatigue. "Where should we go?" has 500 answers and you have 20 minutes of planning energy on a Tuesday night.
>
> Travel apps make you search. Nobody should have to search for a weekend.

**Tweet 3 · 2:30 PM — the insight**

> Here's the thing about India: the answer to "where should I go this weekend?" is almost deterministic.
>
> November? Jaisalmer, not Manali. July? Not Goa (monsoon), yes Spiti.
> Weather + distance + number of free days = the trip picks itself.
>
> So why isn't the calendar doing this for me?

**Tweet 4 · 6:00 PM — the vision**

> What I'm building:
>
> 📅 One big calendar — weekends glow, long weekends get flagged automatically (Diwali + Monday = 3 days, it knows)
> ✈️🏍️🚌 Every free window pre-filled with a flight pick, a bike pick, a bus pick
> 🌦️ Weather-aware — monsoon destinations sit out the monsoon
> 🌍 India + international toggle
> ↻ Don't like a pick? Refresh cycles the next best one.
>
> Zero searching. Open calendar → see trip → go.

**Tweet 5 · 9:00 PM — the teaser**

> Naming it Northstar Nomad 🧭
>
> Night-sky UI: your free weekends literally glow like stars, and long weekends form constellations.
>
> Shipping the whole thing tomorrow and posting the full build breakdown — stack, architecture, and every AI agent I used. Stay tuned.

---

## Day 2 — The build story (features, stack, AI agents)

**Tweet 1 · 9:30 AM — it's built**

> Shipped it: Northstar Nomad 🧭 — a travel calendar that fills your free weekends for you.
>
> Click any weekend → a drawer slides in with the 3 best trips for those exact dates: flight ✈️, bike 🏍️, bus with friends 🚌. India or international. Weather-checked.
>
> Here's how it was built 🧵👇

**Tweet 2 · 11:00 AM — the features**

> What it does:
>
> • Detects weekends AND long weekends from Indian public holidays (it knows Diwali Sat–Mon is a 3-day window)
> • 30+ destinations, each with a 12-month weather profile — Goa scores 2/10 in July, 10/10 in December
> • Scoring engine: weather fit × trip-length fit − distance penalty. A 2-day weekend will never suggest Ladakh; a week off will.
> • ↻ refresh rotates through ranked alternatives — deterministically, so it's never empty and never random garbage
> • Every card shows the forecast for YOUR dates, budget tier, and a "why now" line

**Tweet 3 · 1:30 PM — the stack**

> The stack (deliberately boring, in a good way):
>
> Backend: Node 20 + Express + TypeScript. No DB — the whole dataset is hardcoded and versioned in git. Vitest + supertest, 60 tests.
> Frontend: React 18 + Vite + Tailwind. No image CDN — every destination hero is a pure CSS gradient.
> Monorepo: npm workspaces, `server/` + `web/`, one command to run both in watch mode.
>
> The recommendation "engine" is ~100 lines. You don't need ML to know Jaipur in May is a bad idea.

**Tweet 4 · 4:00 PM — the AI workflow**

> The interesting part: how it was built.
>
> Claude Code (Fable 5) drove the whole thing through 22 phases, each one a clean git commit — scaffold → dataset → scoring engine → API → calendar UI → trip drawer → polish.
>
> Agents/skills used:
> 🧠 brainstorming skill → turned my rambling idea into a spec
> 📋 writing-plans skill → 22-phase implementation plan, committed before any code
> 🎨 frontend-design skill → the night-sky "constellation calendar" direction (weekends glow like stars, long weekends connect into constellations)
> ✅ TDD throughout — engine logic was tested before the UI existed

**Tweet 5 · 7:00 PM — the design + what's next**

> Design decision I'm most happy with: the calendar IS the app.
>
> No feeds, no search bar, no onboarding. You look at your month, something glows, you click it, you book it.
>
> Next up:
> • AI trip copilot (itineraries + packing lists per pick)
> • Live weather API instead of climatology
> • Price snapshots for the flight picks
>
> Repo + build log in the replies. Go steal the idea for your own city. 🧭

---

### Posting notes

- Attach a screen recording of: calendar → click Diwali long weekend → drawer slides in → hit ↻ on the bike column. That 10-second loop is the whole pitch.
- Day 1 Tweet 1 and Day 2 Tweet 1 are the anchors; pin Day 2 Tweet 1 after posting.
- Reply to Day 2 Tweet 5 with the GitHub link once the repo is public.
