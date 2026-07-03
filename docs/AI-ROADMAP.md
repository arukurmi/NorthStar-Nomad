# Northstar Nomad — AI Integration & Feature Roadmap

How to evolve the hardcoded travel calendar into an AI-powered travel companion
that helps users before, during, and after every trip — domestic and foreign.

Recommended stack: Claude API (`claude-fable-5` for reasoning-heavy features,
`claude-haiku-4-5` for cheap high-volume ones) via a thin `server/src/ai/`
service layer, so every feature below is one endpoint + one prompt template.

## Tier 1 — Planning (before the trip)

1. **AI Trip Copilot** — for any pick, generate a day-by-day itinerary sized to
   the exact date range ("Sat–Mon in Jaisalmer"), including sunrise/sunset
   timing, booking tips, and a route order that minimises backtracking.
2. **Packing list generator** — from destination + dates + weather profile +
   travel mode (bike trips get gear lists: gloves, rain liners, tool kit).
3. **Budget estimator** — itemised estimate (transport, stay, food, activities)
   per budget tier, with a "friends split" view for bus-group trips.
4. **Natural-language trip search** — "somewhere cold, under ₹8k, riding
   distance, next long weekend" → AI translates to engine filters and returns
   scored picks. This becomes the search bar the app deliberately doesn't have.
5. **Group consensus mode** — friends each type preferences; AI negotiates one
   pick with a "why this works for everyone" explanation.
6. **Visa & document checker (international)** — per destination + nationality:
   visa type (VoA/e-visa/sticker), typical processing time, required documents,
   passport-validity rules, and a personalised checklist with deadlines
   counting back from the departure date.
7. **Smart calendar sync** — read the user's Google Calendar (consented) to
   find *actually* free windows, not just weekends; AI summarises conflicts
   ("free after 2 PM Friday — leave post-lunch and you make Rishikesh by 8").

## Tier 2 — In-trip help (the "any help requirement" layer)

8. **24×7 destination concierge chat** — context-loaded with the user's
   destination, dates, and itinerary: "pharmacy open now near Ubud centre?",
   "is the Chandratal road open today?". Grounded with a web-search tool call.
9. **Live translation & phrasebook** — offline-cached top-50 phrases per
   destination language; camera translation for menus/signs; polite-form
   coaching ("how to bargain in a Hanoi market without offending").
10. **Emergency assistant** — one tap surfaces local emergency numbers, nearest
    embassy/consulate (foreign trips), hospital directions, insurance claim
    steps; AI drafts the incident report / insurance email for you.
11. **Replan on disruption** — flight cancelled, landslide on route, sudden
    rain: AI re-sequences the remaining days, suggests indoor swaps, and
    drafts the hotel-change messages.
12. **Local etiquette & scam radar** — per-destination briefing: common
    tourist scams, tipping norms, dress codes for religious sites, taxi-fare
    sanity ranges.
13. **Food guide with constraints** — "vegetarian + no peanuts in Da Nang" →
    dish names to order, dish names to avoid, how to say the allergy locally.

## Tier 3 — Data upgrades (make the engine live)

14. **Live weather forecasts** — swap the climatology tables for a forecast API
    (e.g. Open-Meteo) for trips within 14 days; keep month profiles as the
    fallback for far-future dates. AI writes the human "why now" line from the
    raw forecast.
15. **Price snapshots** — daily cached flight/bus fare ranges for the top
    picks; the scoring engine gains a value term ("Goa is 40% cheaper than
    usual for these dates").
16. **Crowd & event awareness** — festivals, marathons, long-weekend surge
    warnings ("everyone in Delhi is going to Manali this weekend — here are
    three quieter alternatives at the same drive time").
17. **Auto-growing dataset** — an offline AI pipeline that drafts new
    destination entries (month scores, weather blurbs, tags) for human review,
    instead of hand-writing every one.

## Tier 4 — Memory & community (after the trip)

18. **Trip journal auto-draft** — from photos' timestamps/locations, AI drafts
    a shareable trip recap; one tap posts the thread.
19. **Taste learning** — learn from accepted/refreshed/ignored picks; the
    rotation becomes personal ("you always skip beaches in winter — noted").
20. **Companion matching** — opt-in: match users planning the same long
    weekend + destination + mode (bike convoys especially).
21. **Post-trip Q&A give-back** — travellers answer one question about where
    they just were; answers ground the concierge for the next user (RAG over
    community answers).

## Suggested build order

Copilot (1) → packing (2) → NL search (4) → visa checker (6) → concierge (8)
→ live weather (14). Each is one endpoint, one prompt, one drawer panel —
the same phase-per-commit rhythm as the base app.
