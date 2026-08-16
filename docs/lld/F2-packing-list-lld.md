# LLD F2 — Packing List Generator

| | |
| --- | --- |
| **Status** | Ready to implement |
| **Branch** | `feat/f2-packing-list` |
| **PRD** | `docs/prds/F2-packing-list-generator.md` |
| **Cluster spec** | `docs/superpowers/specs/2026-08-14-byok-ai-planning-cluster-design.md` |
| **Depends on** | F0 (merged) |
| **New runtime deps** | **none** — `node:crypto` and `better-sqlite3` are already here |
| **First writer to `ai_cache`** | **yes** — this document settles `docs/THREAT-MODEL.md` §5 |

## 0. Ground rules

Same as F0's. Persistence is the real SQLite database; the DDL goes into the one
existing `db.exec()` block in `server/src/db.ts`, all `IF NOT EXISTS`, because
there is no migration runner. The only fake in the system is the outbound
provider HTTP layer (`ai/providers/fake.ts`). No test touches the network. No
new npm dependency: validation is a hand-written `parse` function, matching the
`CompletionRequest.parse` contract F0 designed precisely so that zod would never
be needed.

---

## 1. Assumptions

Every ambiguity in the PRD, resolved as a decision.

| # | Ambiguity | Decision |
| --- | --- | --- |
| A1 | **`tripId` in the request body.** The PRD's example request carries `{ …, "tripId": 42 }`. | **Optional, and belt-and-braces.** The server derives the trip itself from `(userId, destinationId, start, end, mode)` — those four fields already identify it uniquely, and deriving it deletes an IDOR surface outright. `tripId` is still accepted, to keep the PRD's wire shape: when present it must be the caller's own trip **and** must match the tuple, or the request is a `400` — one shared message for malformed, foreign and mismatched, so the field is no existence oracle. Being silently ignored would be worse than refused: the client asked to tick against that trip and would get a list with no checkboxes and no reason why. It is never trusted as the sole source of the trip. |
| A2 | `itemKey` is absent from the PRD's response example, yet the PRD requires tick state "keyed by a stable item key". | The server derives `itemKey` and returns it inside every item. The client never computes one. |
| A3 | What `trip_packing` stores. | The **whole checklist snapshot** — category, label, qty, reason, order, checked — not just booleans. See §4.2. This is what makes "tick state survives reload" true even after the cache row has expired, and what lets the profile page render and tick a list with **no AI key configured at all**. |
| A4 | Can a user generate a list for dates with no saved trip? | Yes. Generation does not require a trip. **Ticking does.** No matching trip → the response omits `trip` and the UI disables the checkboxes with "Save this trip to tick items off". |
| A5 | Where do the trip-scoped routes live? | `server/src/routes/trips.ts`, not a new router. `/api/trips` authorisation is mounted there; two routers both owning that prefix is how an inconsistency gets in. The AI route itself lives in `routes/ai-packing.ts`, per the cluster spec's file layout. |
| A6 | `mode` is optional on `POST /api/trips` (defaults `'flight'`). | **Required** on `POST /api/ai/packing`. Defaulting would hand a bike rider a flight list — the exact failure this feature exists to prevent. |
| A7 | Trip-length bound. | 1–30 days. Bounds prompt size, bounds the quantity arithmetic, and caps the distinct-cache-key space a script can mint. |
| A8 | Calendar validity of dates. | `2026-02-30` is rejected via an ISO round-trip. `trips.ts` does not do this today; F2 does, because the date string reaches both the prompt and the cache key. Not retrofitted to `trips.ts` here. |
| A9 | Model pinning for the cache. | **Not pinned.** See §2.1. |
| A10 | Per-user throttle on the packing route. | **Added** — 30/hour, reusing `ai/rateLimit.ts`. THREAT-MODEL §4 lists "spend the victim's provider credit through our features" as an accepted F0 risk *because F1–F4 did not exist yet*. F2 makes it real. |
| A11 | Does the Pack tab generate on mount? | **No.** Mount-triggered generation bills the user for opening a tab. One call per explicit click — cluster principle 5. |
| A12 | `web/` test runner. | Still none, and F2 does not introduce one. Web phases verify by `tsc --noEmit` + `vite build` + a written manual checklist, exactly as F0's web phases did. Stated plainly so nobody reads a green run as browser verification. |
| A13 | Snapshot mechanism for the prompt. | Committed `.txt` fixtures compared with `toBe`, **not** `toMatchSnapshot()`. The repo has zero snapshot files, and `vitest -u` silently blessing a prompt regression is precisely the failure a prompt test must not have. Fixtures are data; changing one is always a deliberate reviewed diff. |

---

## 2. The two binding decisions

F2 is the first feature to write a row to `ai_cache`. THREAT-MODEL §5 says the
first writer settles these. It does.

### 2.1 Decision 1 — cache poisoning and cross-provider serving

**Chosen: add a required `provider: ProviderId` to `CacheKeyInput` and project
it in `cacheKey()`.** Two lines in `server/src/ai/cache.ts`. Not the `options`
bag. Not a server-pinned model set.

**Why change `cache.ts` rather than pass `provider` through `options`.** The
`options` route is tempting because it is zero-risk — `options: { provider }`
reaches the hash today with no edit to a shared module. But it makes the
namespace guarantee a *convention* that F1, F3 and F4 each have to remember
independently, in four separate route files, with no compiler and no test behind
it. Three features from now one of them forgets, and the failure is silent: a
correct-looking answer served from the wrong vendor. THREAT-MODEL §5 already
says it — *"Adding `provider` costs one line and removes the question."* This is
the cheapest moment in the project's life to spend that line: `cache.ts` has
zero production callers today, `ai_cache` is empty in every deployed database,
and the test DB is `:memory:`. There is no stale row to invalidate and no
migration to write. It will never be cheaper than right now.

**Why the field is required.** It shipped optional first, on the reasoning that
`canonical()` strips `undefined` so every existing key stayed byte-identical and
no existing test needed editing. Review pushed back and was right: an optional
field does not remove the "every route must remember" problem, it moves it —
which is the exact objection that ruled out threading it through `options`.
Every `AiFeature` is a model call, so every caller has a provider, and making
the compiler say so costs one keyword. The pre-provider digest survives as a
pinned regression anchor in `cache.test.ts`, behind a deliberate cast, because
what it guards is stored rows rather than an API.

**Why no server-pinned model set.** Pinning does one of two bad things. Either a
user on `claude-haiku-4` is served a `claude-sonnet-5` answer — better output,
but a lie about what they configured, and it makes `ai_usage.model` wrong. Or
caching is silently disabled for anyone off the pinned list, which is a cost
surprise for exactly the users most likely to be watching cost, and a direct
violation of principle 5. `model` is already in the key and that is the correct
behaviour. Fragmentation is bounded because the three vendor defaults cover
essentially every user. Note also that a user-chosen model string cannot forge a
*collision*: `canonical()` runs every string through `JSON.stringify`, so no
amount of `|`, `"` or `}` in a model id can fake a delimiter.

**Why cross-provider poisoning is now structurally closed.** Writing a cache row
requires a *successful* completion, and all three adapters hardcode their
vendor's base URL. An Anthropic key can therefore only ever produce rows
namespaced `provider: "anthropic"`, and no user can name an arbitrary endpoint.
The residual is "a real vendor's real model gave a mediocre answer", which is
the accepted floor for any shared cache.

#### Settling THREAT-MODEL §5 question 1 — can user free text reach a cached payload?

**No, and it is enforced by construction rather than by review.** Three parts:

1. `POST /api/ai/packing` reads exactly four scalars from the body:
   `destinationId`, `start`, `end`, `mode` (plus the optional `tripId` and
   `provider`, neither of which reaches a prompt). `destinationId` must resolve
   against `allDestinations` — our catalogue — or the request is a 400. `mode`
   must be in the enum. The dates must match `/^\d{4}-\d{2}-\d{2}$/`, round-trip
   through `Date`, and be ≤ 30 days apart. **There is no free-text field.**
2. `buildGrounding(dest, start, end, mode)` takes a **`Destination` object**, not
   a request body. Its return type `PackingGrounding` has no index signature,
   and `packingUserPrompt(g)` interpolates only `PackingGrounding` fields. A body
   property therefore has no path into a prompt string that is not a compile
   error.
3. `parsePackingList` **projects field by field** into a freshly constructed
   object. Nothing the model emits outside the declared shape reaches
   `putCached`.

Two canary tests hold this up: a POST carrying `{ …, note: CANARY, hint: CANARY }`
must produce a prompt containing neither string, and a `SELECT payload FROM
ai_cache WHERE feature = 'packing'` containing neither string.

The one remaining user-influenced string in the tuple is `model`, from the user's
own `ai_keys` row. It reaches the cache **key** and the vendor request; it never
reaches the prompt and never reaches the payload. Stated here so nobody
rediscovers it as a finding.

**§5 question 3 — is a cached answer distinguishable to the user?** Settled: the
response carries `cached: boolean` **and** `generatedAt`, and the UI renders
"Generated 12 days ago · free". **§5 question 5 — no payload integrity check**
remains accepted, and is only acceptable because question 1 now holds
structurally.

### 2.2 Decision 2 — TTL and eviction

**Read TTL: `PACKING_MAX_AGE_MS = 30 days`.**

A packing list is a function of four things that are all *static data in this
repository*: the destination row, the month climatology in `dest.weather`, the
trip length, and the mode. Unlike an itinerary naming venues, it does not decay
because the world moved. So the case for expiry is not freshness. It is exactly
three things:

1. **Our catalogue gets edited** — a `tempMin` correction should reach users.
2. **The prompt gets edited** — handled *not* by the TTL but by
   `PACKING_PROMPT_VERSION` in `options.pv`. Bumping it changes every key
   instantly and deliberately. A TTL is the wrong instrument here: too slow and
   too imprecise.
3. **One bad generation should not be permanent.**

Only (1) and (3) are the TTL's job, and both operate on a scale of weeks.

The number is chosen from the other side too, which is the binding one: **a cache
hit is free, so a longer TTL is strictly pro-user.** Real behaviour is "plan a
trip, then reopen the Pack tab four or five times over the following weeks as the
date approaches". A 24-hour TTL re-bills that user on every visit, directly
violating principle 5. Seven days still re-bills anyone planning more than a week
out — i.e. everyone. Thirty days covers a normal planning cycle end to end for
free. The only cost is staleness of data we control and can invalidate by hand.

The constant lives in `ai/prompts/packing.ts` beside `PACKING_PROMPT_VERSION`,
because both are properties of *this prompt's answers*, not of the cache
mechanism. F1/F3/F4 declare their own.

**Write eviction: bounded per-feature sweep, 2000 rows, oldest-write-first.**

```ts
export function evictFeature(
  feature: AiFeature,
  keep: number,
  opts?: { protect?: string },
): number;
```

```sql
DELETE FROM ai_cache
 WHERE feature = ?
   AND cache_key NOT IN (
         SELECT cache_key FROM ai_cache
          WHERE feature = ?
          ORDER BY created_at DESC, cache_key DESC
          LIMIT ?
       )
```

**Why 2000.** The realistic working set is countable: the catalogue is ~32
destinations × 3 modes = ~96 `(destination, mode)` pairs, and a given month has
roughly 4–6 live long-weekend date ranges. 96 × 5 ≈ 480 rows *per model* — and
the key is namespaced by provider and model, so the true working set is 480 ×
however many distinct models are in use. 500 was the first number here and it
was wrong: across three vendor defaults it meant eviction fired constantly in
normal operation. 2000 holds all three at once, so the sweep only bites on
genuine abuse. At ~3 KB a payload that is ~6 MB — negligible beside a WAL SQLite
file — and it converts an unbounded growth path (a script iterating distinct
date ranges) into a bounded one.

**What the bound does not do**, stated because review found it and it is a real
residual: the budget is **shared across every user**. Somebody issuing 2000
distinct legitimate requests evicts everyone else's rows and makes them re-pay
on their next visit. It costs the attacker 2000 completions billed to their own
key and the route's 30/hour throttle bounds the rate, but it is not eliminated.
Fixing it properly needs a per-caller partition, which needs a column, which
needs a migration runner this repo does not have. Recorded in
`docs/THREAT-MODEL.md` rather than left implicit.

**Why a `protect` key.** The `created_at` tie-break is not enough on its own.
`datetime('now')` resolves to the second, so a burst of writes shares a
timestamp and the ordering collapses to `cache_key DESC` alone — a newly written
key that sorts low is then deleted by its own sweep, the next read misses, and
the user pays twice for one answer. `putCached` passes the key it just wrote,
so a feature holds at most `keep + 1` rows rather than exactly `keep`.

**Why `keep` and the cache key are validated.** SQLite reads `LIMIT -1` as "no
limit", so a negative bound would silently sweep nothing — a bound that becomes
unbounded is the one failure this function exists to prevent. And a row written
under the `""` sentinel would be shielded from every future sweep forever, so
`putCached` rejects anything that is not a 64-hex digest.

**Why oldest-write-first rather than LRU.** `created_at` is the only timestamp
the table has, and `putCached`'s `ON CONFLICT` refreshes it, so this is really
least-recently-*written*. True LRU needs a `last_read_at` column, which means
(a) `ALTER TABLE` in a repo with no migration runner, and (b) turning every cache
**read** into a **write** — on a synchronous single-process better-sqlite3 that
is a real cost for no user-visible gain, and it makes `getCached` non-idempotent,
which is a nasty property for a function tests call repeatedly. The 30-day TTL
already removes stale entries from service; the row bound exists for space, and
for space, write-recency is a fine proxy.

**Why `ORDER BY created_at DESC, cache_key DESC`.** `datetime('now')` has
one-second resolution. Without the tie-break, a burst of writes inside one second
gives SQLite an arbitrary order and the survivor set stops being a function of
the table's contents. It makes the sweep deterministic; it is `protect`, above,
that makes it safe.

**Index.** `idx_ai_cache_feature(feature, created_at)` already exists and serves
both the subquery's filter and its ordering. Nothing new.

**Where it runs.** Inside `putCached`, in the same `db.transaction()`, so a
concurrent WAL reader never observes the table mid-sweep. `putCached` gains an
optional fourth argument rather than a separate call the route could forget:

```ts
export function putCached<T>(
  key: string,
  feature: AiFeature,
  payload: T,
  opts?: { keep?: number },
): void;
```

`keep` omitted ⇒ no sweep ⇒ every existing `cache.test.ts` assertion untouched.

**No second age-based sweep.** Expired rows are invisible to readers
(`getCached` returns `null`) and their space is reclaimed by the row bound. A
cron would be a second mechanism for a problem the first already covers, and this
app has no scheduler.

---

## 3. Modules affected

### 3.1 Server — data

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `server/src/db.ts` | **Mod** | Append `trip_packing` DDL to the single `db.exec()` block. |
| `server/src/db.test.ts` | **Mod** | Table, composite PK, both CHECKs, and *no* `user_id` column. |
| `server/src/ai/cache.ts` | **Mod** | `provider?` on `CacheKeyInput`; `evictFeature()`; `putCached(…, { keep })`. |
| `server/src/ai/cache.test.ts` | **Mod** | Provider namespacing + eviction. Existing assertions unchanged. |
| `server/src/ai/packingStore.ts` | **New** | The only module that reads or writes `trip_packing`. |
| `server/src/ai/packingStore.test.ts` | **New** | Sync/preserve/prune, tick, cross-user isolation, counts. |

### 3.2 Server — domain

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `server/src/ai/packing.ts` | **New** | `PackingList` types, `PACKING_SCHEMA`, `PackingShapeError`, `parsePackingList`, `makePackingParser`, `itemKeyFor`, `MODE_CATEGORY_TITLE`. |
| `server/src/ai/packing.test.ts` | **New** | Accept/reject matrix, item-key stability, projection. |
| `server/src/ai/prompts/packing.ts` | **New** | `PACKING_PROMPT_VERSION`, `PACKING_MAX_AGE_MS`, `PACKING_CACHE_LIMIT`, `buildGrounding`, `packingSystemPrompt`, `packingUserPrompt`, `quantityGuide`, `MODE_BRIEF`. |
| `server/src/ai/prompts/packing.test.ts` | **New** | Byte-exact fixtures, mode divergence, quantity scaling, no user text. |
| `server/src/ai/prompts/__fixtures__/packing.*.txt` | **New** | System prompt + three grounding fixtures. |

### 3.3 Server — transport

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `server/src/routes/ai-packing.ts` | **New** | `POST /api/ai/packing`. Owns the per-user throttle. |
| `server/src/routes/ai-packing.test.ts` | **New** | Happy path, cache, mode divergence, full error matrix, canaries. |
| `server/src/routes/trips.ts` | **Mod** | `GET /api/trips/:id/packing`, `POST /api/trips/:id/packing/check`, transactional cascade on delete, `packing_total`/`packing_checked` on the list. |
| `server/src/routes/trips.test.ts` | **New** | *No trips test file exists today.* |
| `server/src/app.ts` | **Mod** | Mount `aiPackingRouter`. |
| `server/src/routes/ai-keys.test.ts` | **Mod** | Add the three new routes to F0's leak sweep. |

### 3.4 Web

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `web/src/lib/types.ts` | **Mod** | Mirror the wire types. |
| `web/src/lib/ai.ts` | **Mod** | `generatePacking`, `readTripPacking`, `setPackingItem`. |
| `web/src/lib/auth.tsx` | **Mod** | `Trip` gains `packing_total?` / `packing_checked?`. |
| `web/src/hooks/usePacking.ts` | **New** | Panel state machine + optimistic tick. |
| `web/src/components/Packing/PackPanel.tsx` | **New** | The Pack tab body; owns every branch. |
| `web/src/components/Packing/PackingProgress.tsx` | **New** | "11 / 24 packed" + gradient bar. |
| `web/src/components/Packing/PackingCategory.tsx` | **New** | Collapsible section; mode category open by default. |
| `web/src/components/Packing/PackingItemRow.tsx` | **New** | Checkbox, qty pill, label, `reason` as quiet secondary text. |
| `web/src/components/Packing/PackingSkeleton.tsx` | **New** | Shimmer rows while generating. |
| `web/src/components/Packing/TripPackingCard.tsx` | **New** | Profile trip-row card. |
| `web/src/components/Ai/AiErrorNote.tsx` | **New** | Shared code-driven error copy for F1–F4. |
| `web/src/components/TripDrawer/DestinationTabs.tsx` | **New** | Overview / Pack pill tabs. F1 slots "Plan" in with one line. |
| `web/src/components/TripDrawer/DestinationDetail.tsx` | **Mod** | Extract Overview; render tabs; mount `PackPanel`. |
| `web/src/pages/ProfilePage.tsx` | **Mod** | Render `TripPackingCard` on planned trips. |

### 3.5 Docs

`README.md` (API table rows), `docs/THREAT-MODEL.md` (§5 rewritten from open
questions into settled decisions; residual risk #4 reclassified), this file.

No `package.json`, `tsconfig`, `vitest.config.ts` or `tailwind.config.js`
changes. No new dependency.

---

## 4. Data model

### 4.1 DDL — appended to the single `db.exec()` in `server/src/db.ts`

```sql
  CREATE TABLE IF NOT EXISTS trip_packing (
    trip_id    INTEGER NOT NULL REFERENCES trips(id),
    item_key   TEXT    NOT NULL,
    category   TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    qty        INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
    reason     TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    checked    INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trip_id, item_key)
  );
```

### 4.2 Why this design

- **PK `(trip_id, item_key)`** is the upsert target, makes "one row per item per
  trip" a database invariant, and SQLite materialises it as an index prefixed by
  `trip_id` — which is the only read predicate. **No secondary index**; one would
  be dead weight, exactly as F0 argued for `ai_keys`.
- **No `user_id` column.** A trip already has exactly one owner in
  `trips.user_id`; copying it here creates a second source of truth that can
  disagree with the first. Every statement resolves ownership through `trips`:
  `… WHERE trip_id = (SELECT id FROM trips WHERE id = ? AND user_id = ?)`. A
  non-owner's `changes` is `0`, which becomes a **404** — identical to
  `trips.ts`, no existence oracle, never a 403.
- **`checked` is a stored 0/1, not row presence.** Unchecking is a real state
  transition with a real `updated_at`; the endpoint is idempotent; the round-trip
  test asserts a value rather than an absence.
- **`sort_order` is the flattened index across the whole list**, so the profile
  card renders in the model's intended order with nothing re-derived.
- **`category` is the display string** (`"Mode — Bike"`). There is never a query
  by category, only a group-by on read, so a category table buys nothing.
- **`reason` is nullable** — the PRD requires it only on non-obvious items.
- **The row bound per trip is 48** (6 categories × 8 items, the parser's own
  maximum). Not expressible as a constraint; enforced by `parsePackingList`.
- **No `ON DELETE CASCADE`.** `PRAGMA foreign_keys` is off, matching `trips`, so
  the reference is documentation. The real cascade is explicit and transactional
  in `trips.ts`'s DELETE, mirroring F0's `deleteKey`/`ai_prefs` cleanup.

### 4.3 Stable item key

```
slug(s) = s.normalize("NFKD").toLowerCase()
           .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
itemKey = sha256(`${slug(category)}|${slug(label)}`).digest("hex").slice(0, 16)
```

- **Category is in the input** because "Gloves" in *Clothing* and "Gloves" in
  *Mode — Bike* are two different checkboxes.
- **Slug before hash** is the whole point. Regeneration produces cosmetic drift —
  `"Rain liners"`, `"rain liners"`, `"Rain  liners"`, `"Rain-liners"` — and all
  four must collapse to `rain-liners` so a tick survives. An index-based key
  (`cat0.item3`) breaks the instant the model reorders, which it does.
- **Hash rather than store the slug** keeps `item_key` fixed-width, keeps
  unbounded model-authored text out of a primary key, and gives one uniform shape
  to validate on the tick endpoint (`/^[0-9a-f]{16}$/`).
- **64 bits** — over ≤ 48 items the collision probability is ~6×10⁻¹⁶.
- **Duplicates are a hard parse failure**, not a silent merge: two checkboxes
  sharing one tick is worse than a retry. Duplicate *category names* fail for a
  sharper reason — `readStoredList` groups persisted rows by `category`, so two
  sections called "Gear" rehydrate as one after a reload and the list the user
  sees stops matching the list that was generated.
- **`slug` strips combining marks and falls back for non-Latin labels.** Without
  the first, "Naïve" slugs to `nai-ve` and "Naive" to `naive`, so exactly the
  drift this is meant to survive breaks a tick. Without the second, any label
  with no ASCII alphanumerics slugs to `""`, two Devanagari labels in one
  category collide, and valid model output becomes a 502.

The key is derived from category + label only, so it is not user-specific and
correctly belongs in the shared cached payload. `checked` never does.

---

## 5. Interfaces

### 5.1 `server/src/ai/packing.ts`

```ts
export interface PackingItem {
  /** 16 lowercase hex chars. Derived server-side; the client never computes one. */
  itemKey: string;
  label: string;
  qty: number;
  /** Omitted entirely when the model had nothing non-obvious to say. */
  reason?: string;
}

export interface PackingCategory {
  name: string;
  /** True for the one category matching MODE_CATEGORY_TITLE[mode]. Drives
   *  "expanded by default" without the client string-matching a heading. */
  modeCategory: boolean;
  items: PackingItem[];
}

export interface PackingList {
  summary: string;
  categories: PackingCategory[];
}

export const MODE_CATEGORY_TITLE: Record<TravelMode, string>;
export const PACKING_SCHEMA_NAME = "packing_list";
export const PACKING_SCHEMA: JsonSchemaObject;

export type PackingShapeReason =
  | "not_object" | "missing_field" | "wrong_type" | "empty_string"
  | "too_long" | "out_of_range" | "count_out_of_range" | "duplicate_item";

/** Carries structure, never the offending value — model text must not reach a log. */
export class PackingShapeError extends Error {
  readonly reason: PackingShapeReason;
  readonly path: string;   // e.g. "categories[2].items[5].label"
}

export function itemKeyFor(categoryName: string, label: string): string;
export function parsePackingList(value: unknown, mode: TravelMode): PackingList;
export function makePackingParser(mode: TravelMode): (v: unknown) => PackingList;
```

**Why `makePackingParser` is a factory.** `CompletionRequest<T>.parse` is
`(value: unknown) => T`, so the mode must be closed over. Doing it this way sets
`modeCategory` inside the same single pass that validates, so the flag is already
present in `result.data` when the route calls `putCached`. The alternative — a
`markModeCategory(list, mode)` post-step — is a step the cache-**miss** path can
forget while the cache-**hit** path keeps working. That bug only appears in
production.

**Validation limits — the parser is authoritative, the schema is advisory:**

| Field | Rule |
| --- | --- |
| `summary` | string, trimmed, 1–280 chars |
| `categories` | array, 4–6 entries |
| `categories[].name` | string, trimmed, 1–40 chars |
| `categories[].items` | array, 3–8 entries |
| `items[].label` | string, trimmed, 1–60 chars |
| `items[].qty` | integer, 1–20 |
| `items[].reason` | absent, `null`, `""`, or 1–160 chars. `null`/`""` ⇒ omitted |
| whole list | no duplicate `itemKey`, and no duplicate category `name` |
| any node | unknown extra properties are **dropped**, not rejected |

Two things worth stating plainly. First, **the parser must be authoritative**:
F0's `toVendorSchema` for Gemini *strips* `minItems`/`maxItems`/`minimum`/
`maximum` because Gemini 400s on them, and OpenAI strict mode strips them too —
so on two of three vendors the schema's counts are advice. Second, **OpenAI
strict mode sets `required` to every property key**, so `reason` becomes
mandatory and the model emits `reason: null` or `""` for obvious items;
`JsonSchemaNode` cannot express a `string | null` union, so the parser absorbs
both. Neither is discoverable from the schema; both are load-bearing.

### 5.2 `server/src/ai/prompts/packing.ts`

```ts
export const PACKING_PROMPT_VERSION = 1;
export const PACKING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PACKING_CACHE_LIMIT = 500;

export interface PackingGrounding {
  destinationName: string; region: string; country: string;
  international: boolean; roadTrip: boolean; idealDays: number; tags: string[];
  start: string; end: string; days: number;
  months: string[];        // every calendar month the trip touches
  tempMin: number;         // coldest tempMin across covered months
  tempMax: number;         // hottest tempMax across covered months
  weatherLines: string[];  // one "June — Monsoon arrives" line per month
  mode: TravelMode;
}

export function buildGrounding(dest, start, end, mode): PackingGrounding;
export function quantityGuide(days: number): string;
export function packingSystemPrompt(): string;
export function packingUserPrompt(g: PackingGrounding): string;
```

### 5.3 `server/src/ai/packingStore.ts`

The only module that touches `trip_packing`. It exists for the same reason
`keystore.ts` does: three endpoints in two route files need the *identical*
ownership predicate, and one operation is a multi-statement transaction. Inlining
that three times is how the third copy ends up missing the `user_id` clause.

```ts
export function findOwnedTrip(args: {
  userId: number; destinationId: string; start: string;
  end: string; mode: TravelMode; tripId?: number;
}): { id: number } | null;

export function syncTripPacking(
  tripId: number,
  userId: number,
  list: PackingList,
): PackingTickState | null;
export function readTickState(tripId: number): PackingTickState;
export function readStoredList(tripId: number, mode: TravelMode): StoredPackingCategory[];
export function setChecked(args: {
  tripId: number; userId: number; itemKey: string; checked: boolean;
}): PackingTickState | null;
export function ownsTrip(tripId: number, userId: number): boolean;
```

`syncTripPacking` is *upsert-then-prune*, not truncate-then-insert. `checked` is
deliberately excluded from the `DO UPDATE SET` list — **that single omission is
the entire "ticks survive a regenerate" guarantee.** Items the model dropped are
pruned so `total` stays exact.

It takes a `userId` and re-checks ownership **inside its own transaction**,
returning `null` when the trip has gone. The caller resolves the trip and then
awaits a vendor call; better-sqlite3 is synchronous, so that await is the only
yield point in the request, and a `DELETE /api/trips/:id` landing in it would
otherwise let the sync re-insert rows for a trip that no longer exists. With
`PRAGMA foreign_keys` off and the cascade already run, those rows are
unreachable forever. Not a cross-user leak — `trips.id` is `AUTOINCREMENT`, so
an id is never reused — but a broken invariant, and the transaction is the only
place it closes without a gap.

`readStoredList` derives `modeCategory` by comparing the stored `category`
against `MODE_CATEGORY_TITLE[mode]`, where `mode` comes from the `trips` row. No
column needed.

### 5.4 What is deliberately *not* an interface

No `PackingRepository`, no `PromptStrategy`, no `CacheProvider`. The only
genuinely varying behaviour here is the AI vendor, and `AiProvider` already
covers it. `packingStore.ts` is a concrete module of prepared statements against
the one real database, exactly like `keystore.ts`; it will never have a second
implementation.

---

## 6. Error taxonomy

Closed set. Every code is already in F0's `AiErrorCode` union or in the local
`bad_request`/`not_found` pair. **F2 adds no new code**, which is the point.

| `code` | HTTP | Meaning in F2 |
| --- | --- | --- |
| `unauthenticated` | 401 | No or expired bearer token |
| `bad_request` | 400 | Unknown `destinationId`; dates not `YYYY-MM-DD`, not a real calendar date, `start > end`, span > 30 days; bad `mode`; bad `provider`; `tripId` not owned or not matching the tuple; `itemKey` not `/^[0-9a-f]{16}$/`; `checked` not boolean |
| `not_found` | 404 | `:id` is not this user's trip, does not exist, or the item is not on its list — one indistinguishable response for all three |
| `no_key` | 428 | No AI key configured |
| `invalid_key` | 401 | Vendor rejected the stored credential |
| `insufficient_credit` | 402 | Key valid, account out of funds |
| `rate_limited` | 429 | Vendor throttle **or** our own 30/hour packing limiter |
| `provider_error` | 502 | Vendor unreachable/5xx, or the stored blob failed its GCM tag |
| `bad_output` | 502 | `parsePackingList` rejected the response twice |

**`PackingShapeReason` is not an HTTP taxonomy.** All eight reasons collapse to
one `bad_output` on the wire. `reason` + `path` exist so a failing test says
`"count_out_of_range at categories"` rather than `"bad_output"`, and they travel
only in the `cause` chain, which `AiError.toJSON()` never serialises.
`PackingShapeError.message` carries the reason and the path **only, never the
offending value** — model output is untrusted text, and echoing it into a message
is how log injection happens.

---

## 7. API contract

```ts
export interface PackingRequest {
  destinationId: string;
  start: string;            // YYYY-MM-DD
  end: string;              // >= start, span 1..30 days
  mode: "flight" | "bike" | "bus";
  /** Optional. Must be the caller's own trip AND match the tuple. */
  tripId?: number;
  /** Optional. Forces a vendor; consumed by loadUserKey. */
  provider?: ProviderId;
}

export interface PackingTripState {
  id: number;
  checked: Record<string, boolean>;
  checkedCount: number;
  total: number;
}

export interface PackingResponse {
  cached: boolean;
  generatedAt: string;      // cache row's created_at on a hit; now on a miss
  packing: PackingList;
  trip?: PackingTripState;  // only when a saved trip matches
}

export interface TripPackingResponse {
  categories: StoredPackingCategory[];   // [] when nothing generated yet
  checkedCount: number;
  total: number;
}

export interface PackingCheckRequest  { itemKey: string; checked: boolean }
export interface PackingCheckResponse {
  itemKey: string; checked: boolean; checkedCount: number; total: number;
}
```

### 7.1 `POST /api/ai/packing`

Auth: `requireAuth` + `loadUserKey`. Order of operations — **validation and
ownership happen before any provider call**, so a malformed or unauthorised
request never spends the user's money:

1. `requireAuth` → `loadUserKey`.
2. Per-user throttle → 429 with `Retry-After`.
3. `parsePackingRequest(req.body)` → 400 on any failure.
4. `findOwnedTrip({...})` → `trip | null`. Not an error either way (except an
   explicit non-matching `tripId`, which is a 400).
5. `cacheKey({ feature: "packing", destinationId, start, end, mode, model,
   provider, options: { pv: PACKING_PROMPT_VERSION } })`.
6. `getCached(key, { maxAgeMs: PACKING_MAX_AGE_MS })` — hit ⇒ `recordUsage({…,
   cached: true, 0 tokens })`; miss ⇒ `provider.complete(...)`, then
   `putCached(key, "packing", data, { keep: PACKING_CACHE_LIMIT })` and
   `recordUsage({…, cached: false })`.
7. If `trip` ⇒ `syncTripPacking(trip.id, packing)`.
8. `200`.

**Mount note.** `aiKeysRouter` already does `use("/api/ai", requireAuth)` and is
mounted first, so `requireAuth` runs twice for this path. It is idempotent, and
mounting it explicitly keeps `ai-packing.ts` self-contained rather than dependent
on another router's mount order.

### 7.2 `GET /api/trips/:id/packing`

The **rehydrate-on-reload endpoint**, and the answer to "where does tick state
come from". Reads `trip_packing` only: **no AI key, no provider call, no cache
lookup.** That is why the snapshot design exists — after a reload, or 31 days
later when the cache row has expired, the list and the ticks are still there.
`200 { categories: [], checkedCount: 0, total: 0 }` for an owned trip with
nothing generated is a correct answer, not an error. 401 / 404 otherwise.

### 7.3 `POST /api/trips/:id/packing/check`

```sql
UPDATE trip_packing
   SET checked = ?, updated_at = datetime('now')
 WHERE item_key = ?
   AND trip_id = (SELECT id FROM trips WHERE id = ? AND user_id = ?)
```

`changes === 0` → **404** with the same body whether the trip belongs to someone
else, does not exist, or the item is not on this list. The response returns
**authoritative** counts recomputed from the database rather than echoing the
client's arithmetic — which is what makes two open tabs converge instead of
drift.

### 7.4 `GET /api/trips` (additive)

```sql
SELECT t.*, COALESCE(p.total, 0) AS packing_total,
            COALESCE(p.checked, 0) AS packing_checked
  FROM trips t
  LEFT JOIN (SELECT trip_id, COUNT(*) AS total, SUM(checked) AS checked
               FROM trip_packing GROUP BY trip_id) p ON p.trip_id = t.id
 WHERE t.user_id = ? ORDER BY t.start DESC
```

Two additive fields, so the profile page renders every trip's collapsed packing
card **with zero extra HTTP requests**. The alternative is one
`GET /api/trips/:id/packing` per row on mount — an N+1 for a progress bar. The
full checklist is fetched lazily, only when a card is expanded.

---

## 8. Key logic

- **`parsePackingList`** — recursive descent over a fixed shape: presence → type
  → bounds → project into a fresh object. Computes `itemKey` per item and
  `modeCategory` per category in the same pass, maintains a `Set` of seen keys.
  The from-scratch construction is what guarantees no model-authored extra
  property reaches `putCached` or a response body.
- **`buildGrounding`** — walks the ISO range day by day in UTC collecting every
  calendar month touched; `tempMin` is the min across those months and `tempMax`
  the max. **Not the start month alone** — a 28 Jun → 2 Jul trip using only
  June's numbers is exactly the "cold nights in the desert" failure the PRD opens
  with. Pure: no `Date.now()`, no `Math.random()`, no `toLocaleDateString`
  (ICU-dependent — month names come from a hardcoded array). That purity is what
  makes the fixture comparison deterministic across machines.
- **`quantityGuide(days)`** — computes three integers in TypeScript and injects
  them as literals: `daily = min(days, 7)`, `reuse = min(ceil(days / 2), 4)`,
  `single = 1`. The model copies numbers rather than doing arithmetic, because
  arithmetic is the least reliable thing an LLM does and the PRD makes quantity
  scaling a success criterion. `daily` caps at 7 with the prompt saying why —
  nobody packs 14 t-shirts for a 14-day trip.

---

## 9. Prompt design

### 9.1 System prompt — constant, zero interpolation

Committed verbatim as `__fixtures__/packing.system.txt`. Rules only, never data:
role; 4–6 categories of 3–8 items; category names drawn from Clothing, Gear,
Documents, Health plus **exactly one** mode category whose title is the literal
string given in the user message; `reason` **only** where the item is
non-obvious; quantities from the guide, never invented; **no brand names, no shop
names, no prices, no links**; every claim traceable to the grounding facts; and
never name or reference the traveller — belt-and-braces behind §2.1, because a
global cache would serve a personalised answer to a stranger.

Interpolating nothing keeps the system prompt out of the cache-key conversation
entirely.

### 9.2 User prompt — exactly these grounding fields

Injected: destination name/region/country; `international` (drives Documents —
passport, visa, insurance, adapter); `tags` (terrain and activity → gear);
`idealDays`; `roadTrip`; `start`/`end`/`days`; `months`; `tempMin`/`tempMax`
across **covered** months; one weather summary line per covered month; the mode
and its brief; the quantity guide; the required mode-category title.

**Deliberately excluded, and why** — this list matters as much as the one above:

- `budgetTier` — packing does not vary with budget, and mentioning money invites
  the brand and price talk the system prompt forbids.
- `monthScores` — a *fit* score, not weather. The model would read "3" as a
  temperature or a rating and reason from it.
- `coords` — invites invented altitude and latitude claims no grounding fact
  supports.
- `blurb`, `bestFor`, `heroGradient` — marketing copy; it bleeds into the tone of
  `summary`.
- **Anything at all from the user**: no name, no email, no user id, no trip id.
  Asserted by test.

### 9.3 Forcing mode sections to genuinely differ

The failure mode is cosmetic relabelling — the same six items under three
headings. Three mechanisms:

1. **The exact heading is dictated** (`Mode — Bike`), so the section is
   structurally identifiable and cannot be dodged.
2. **`MODE_BRIEF[mode]` injects domain *constraints*, not items.** This is the
   load-bearing one: give the model a list of bike items and it hands that list
   back; give it the physics and it reasons differently.
   - *bike* — no cabin baggage; everything must survive rain at speed and fit in
     panniers or a tail bag; a mechanical failure is a roadside problem with no
     support; hands, knees, neck and eyes are the exposed joints; wind chill
     subtracts several degrees at speed.
   - *flight* — liquids over 100 ml cannot go in the cabin; power banks over
     100 Wh and sharp tools are restricted; checked baggage can arrive late, so
     one day of essentials and *all* medication travel in the cabin; weight is
     capped.
   - *bus* — luggage goes into a hold you cannot reach mid-journey, so one small
     reachable bag matters; overnight AC runs cold regardless of outside
     temperature; many operators have no charging point; ghat roads make motion
     sickness common.
3. **An explicit negative constraint**: *"Do not place an item in the mode
   section that would appear unchanged in a list for a different travel mode. If
   an item belongs to every mode, it belongs in Clothing, Gear, Documents or
   Health."*

### 9.4 How this is tested deterministically

We cannot unit-test a model. We test the two things we control.

**(a) The instruction genuinely differs.** Build bike and flight prompts for the
same destination and dates, strip every mode word from both, assert the
remainders are **not** equal; assert `/pannier/i` appears in the bike prompt and
not the flight one, and `/cabin/i` the reverse. That assertion fails the day
someone "simplifies" `MODE_BRIEF` into a shared template with the mode word
swapped in — which is exactly the regression the PRD guards against.

**(b) The plumbing carries mode through.** `ai-packing.test.ts` scripts two
different fake payloads and asserts different category sets, two different cache
keys, and the correct mode brief inside `fake.calls[n].user`.

**(c) Byte-exact fixtures.** `packing.spiti-bike-7d.txt` (cold high-altitude,
bike, 7 days), `packing.goa-flight-2d.txt` (monsoon coast, flight, 2 days,
cabin-only), `packing.bali-flight-5d.txt` (international → Documents).

**(d) Quantity scaling.** `quantityGuide(2) ≠ quantityGuide(7)`;
`quantityGuide(14)` caps daily at 7.

---

## 10. Security and edge cases

### 10.1 Ownership / IDOR

- The AI route derives the trip server-side; a supplied `tripId` must be owned
  *and* match the tuple.
- Both `/api/trips/:id/packing*` handlers resolve ownership **inside the SQL**,
  never as a separate read-then-write. `changes === 0` → 404, identical body for
  "someone else's trip", "no such trip" and "item not on this list". Never 403.
- `trip_packing` has no `user_id`, so there is no column through which one user's
  row could be attributed to another.
- **Test:** user B ticks user A's item → assert 404 **and** re-read A's row
  asserting `checked` is unchanged. A 404 that still wrote is the bug this
  catches.

### 10.2 Must never appear in a response, a log, or the cache

| Never | Guard |
| --- | --- |
| Plaintext API key | Inherited from F0. `req.ai` is passed only to `provider.complete()`. The three new routes join the existing leak sweep in `ai-keys.test.ts`. |
| `checked` inside `ai_cache.payload` | Structural: `PackingList` has no `checked` field, and tick state is assembled *after* `putCached`. Test asserts the stored payload contains no `"checked"`. |
| Any user identifier in `ai_cache` | `cacheKey` projects a fixed field list with no `userId`; the table has no `user_id` column. Test: two users, identical tuple, second is `cached: true`. |
| Request-supplied text in prompt or payload | The two canary tests in §2.1. |
| Raw model output in a log or error | `PackingShapeError` carries reason + path only. |

### 10.3 Failure modes handled explicitly

Trip spanning two months → min/max across all covered months. 1-day trip → daily
quantity 1, still 4–6 categories. Span > 30 days or `2026-02-30` → 400 before any
provider call. No saved trip → generate, omit `trip`, disable checkboxes.
Regeneration → ticks preserved on surviving keys, others pruned, `total` exact.
Model returns 3 categories or a duplicate label → parse throws → adapter retries
once → 502 `bad_output`. `reason: null` → normalised to omitted. Prompt version
bumped → different key → miss. Trip deleted → `trip_packing` removed in the same
transaction. Two tabs ticking → last write wins per item, both responses carry
authoritative counts so both converge; better-sqlite3 is synchronous, so there is
no read-modify-write window. 501st cache write in one second → deterministic
tie-break, the just-written row is never evicted.

### 10.4 Boot-time requirements

**None.** F2 adds no environment variable and no boot guard. The DDL is
`IF NOT EXISTS` in the existing block, so an existing `data.sqlite` picks it up
silently on the next boot.

---

## 11. Build order — 5 phases

Every phase leaves the repo green, typechecked and deployable. Nothing later is
required for anything earlier to compile.

| Phase | Branch | Scope | Commits |
| --- | --- | --- | --- |
| 01 | `f2/p01-schema-cache-prompt` | This LLD, `trip_packing` DDL, cache provider-namespacing + eviction, packing types/schema/parser, prompt builder + fixtures | ~10 |
| 02 | `f2/p02-packing-route` | `POST /api/ai/packing`, cache integration, throttle, usage | ~9 |
| 03 | `f2/p03-tick-state` | `packingStore.ts`, tick + read endpoints, trip delete cascade, trip wiring in the AI route | ~11 |
| 04 | `f2/p04-pack-tab` | Web types + client, `usePacking`, packing components, Pack tab | ~10 |
| 05 | `f2/p05-profile-card-docs` | Trips list aggregate, profile packing card, mobile pass, threat-model + README | ~9 |

Reconciliation with the PRD's ten micro-tasks: 1–2 → P01; 3 → P02; 4 is
**split** (DDL rides with P01 because `db.ts` is one `db.exec()` block and
touching it twice is churn; the endpoints need the store, which needs the parser)
→ P01 + P03; 5 is **merged into P02** — a route that calls a provider without
consulting the cache would bill users for the duration of one PR, violating
principle 5, so caching is not a follow-up to the route, it *is* the route;
6–8 → P04; 9–10 → P05. Two additions the PRD does not list, both justified above:
the `cache.ts` provider/eviction work (§2) and the per-user throttle (A10).

---

## 12. Out of scope

Shopping links, affiliate commerce, prices and brand names (actively forbidden in
the system prompt). Weight or volume optimisation. Sharing a list between users.
Editing, adding, renaming or reordering items — v1 is generate + tick.
Regenerate-with-feedback or any free-text steering: **this is the single thing
that would break §2.1's structural guarantee**, so it needs a design change, not
a patch. The Plan tab and everything else in F1/F3/F4 — `DestinationTabs` is
built so F1 adds a tab in one line. Any second cache mechanism. Cache-key
rotation tooling. A spend cap. A shared-store rate limiter. A `web/` test runner.
Retrofitting F2's stricter date validation to `trips.ts`.
