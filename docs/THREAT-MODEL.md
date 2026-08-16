# Threat model — the BYOK key vault

Scope: feature **F0**, the storage and use of user-supplied AI provider API
keys (`server/src/ai/*`, `server/src/routes/ai-keys.ts`, the profile UI), and
**F2**, the first feature to spend one of those keys and the first to write to
the shared `ai_cache` (§5, §5A).
Written against the code as it stands, not against the design intent — every
claim below names the file or the test that holds it up.

Its purpose is to record the risks we **accepted**, not to reassure anyone.
The interesting sections are §2, §3, §4 and §5.

---

## 1. What is stored, and where

`ai_keys`, one row per `(user_id, provider)`:

| Column | Contents |
| --- | --- |
| `ciphertext`, `iv`, `tag`, `salt` | AES-256-GCM. Key = `scrypt(NOMAD_MASTER_KEY, salt, N=16384, r=8, p=1)`. Salt (16 B) and IV (12 B) are fresh on every save. |
| `last4` | **Plaintext.** The last four characters of the key, so a person can tell which credential a row is. Deliberate and disclosed in the UI. |
| `model`, `validated_at`, `created_at` | Not secret. |

The master key lives in the process environment (`NOMAD_MASTER_KEY`), never in
the database and never in the repo. Production and any host carrying a platform
marker (`RENDER`, `K_SERVICE`, `DYNO`, …) refuse to boot without a real one —
`assertVaultConfigured()`, tested in `ai-boot.test.ts`.

Plaintext exists in exactly two places, both request-scoped: the body of a
`POST /api/ai/keys` while it is being validated and sealed, and `req.ai.apiKey`
after `loadUserKey` has opened the row for a feature route. It is never
serialised, never persisted, never logged.

## 2. What the vault does and does not protect against

### It protects against

| Threat | What stops it |
| --- | --- |
| **The database file alone** — a leaked backup, a stolen disk, a snapshot in someone's Downloads folder | Ciphertext is useless without `NOMAD_MASTER_KEY`, which is not in the file. Per-row salts mean one derived key opens one row. |
| **Moving a row between users** — an attacker with *write* access to the DB copying A's blob into B's row to drive A's credential from B's session | GCM additional authenticated data is `${userId}:${provider}` (`vault.ts`, `aadFor`). A transplanted blob fails the tag instead of opening. |
| **Reading a key back through the API** | No endpoint returns plaintext; `listKeys` uses an explicit column list. Enforced by "never returns the plaintext key from any /api/ai endpoint" in `ai-keys.test.ts`, which asserts on body, raw text and headers of every AI route plus the adjacent authed ones. |
| **A key reaching a log line** | Nothing in `src/ai/` logs a key. Enforced by "never writes the key to a console method, stdout or stderr", which spies on `console.{log,warn,error}` and `process.{stdout,stderr}.write` across a save, a provider rejection, and a `loadUserKey` decrypt. |
| **A key reaching a column it shouldn't** | "stores no plaintext key bytes in any ai_keys column" reads the row with `SELECT *` and checks every value, so a column added later is covered without editing the test. |
| **One user reading or deleting another's key** | Every statement is scoped by `req.userId`; a miss is `404`, never `403`, so there is no existence oracle. |
| **Using us as a key-testing oracle** | Ten saves per hour per account — see §6. |

### It explicitly does not protect against

| Threat | Why we accept it |
| --- | --- |
| **An attacker who has the database *and* the environment** | This is one Node process on one host. The process that reads `ai_keys` holds `NOMAD_MASTER_KEY` in its own environment, by necessity. Root on that host, or arbitrary code execution inside that process, is total compromise of every stored key. There is no HSM, no KMS, no separate decryption service. Encryption at rest buys separation from the *file*, and nothing more. |
| **Malicious or buggy code inside our own process** | Plaintext passes through memory on every AI request. A dependency compromise reads it. Our only mitigations are the narrow surface (`req.ai` is documented as never-serialisable) and the leak tests, which catch accidents, not adversaries. |
| **A stolen session token** | See §4. |
| **Anything encrypted under the development master key** | Non-production processes fall back to `DEV_MASTER_KEY`, which is published in this repository. A local or preview `data.sqlite` is, in practice, plaintext. Deployed hosts refuse it. |
| **Abuse of the key at the vendor once it is in use** | We report usage; we do not enforce a spend cap. A bug or an attacker with a session can burn the victim's provider credit up to that vendor's own limits. |
| **A key that was valid at save time and revoked since** | `validated_at` is a point-in-time fact. There is no background re-validation; the next call returns `invalid_key`. |

## 3. Master-key rotation bricks the vault

**Rotating `NOMAD_MASTER_KEY` makes every stored key permanently unreadable.
There is no `rotate()` function anywhere in the codebase.**

Every row's data key is `scrypt(master, row.salt)`. There is no wrapping layer —
no per-row key sealed under the master that could be re-sealed — so changing the
master invalidates every derivation at once. Nothing detects this at boot: the
process starts happily and the failure appears one user at a time, as
`selectKey` catches the GCM tag failure and raises
`provider_error: "your stored key could not be read — remove it and add it
again"`.

Consequences worth stating plainly:

- **A rotation is a user-visible outage of the whole feature**, recoverable only
  by every affected user deleting their key and pasting it again.
- On Render, `render.yaml` sets `NOMAD_MASTER_KEY` with `generateValue: true`.
  It is generated once, on first provision. Clicking "regenerate" in the Render
  dashboard, or recreating the service, brick the vault with no warning from us
  and none from Render.
- The free tier's ephemeral disk resets `data.sqlite` on every deploy anyway, so
  today this risk is masked by a larger one. That stops being true the moment a
  persistent disk is attached.

**Operating rule until a rotation path exists:** treat `NOMAD_MASTER_KEY` as
permanent. If it must change — because it leaked, which is the only good reason —
the honest sequence is: announce it, rotate, and let every user re-add their key;
and if it leaked, they should be revoking those keys at the vendor regardless
(§7).

The missing implementation is not hard, and is deliberately deferred rather than
forgotten: read every `ai_keys` row, open with the old master, re-seal with the
new master and a fresh salt and IV, write back inside one transaction, with both
masters supplied to the process for the duration. It is out of scope for F0
because F0 has no users yet.

## 4. Sessions: a 30-day, non-revocable JWT in `localStorage`

`TOKEN_TTL = "30d"` (`auth/tokens.ts`). The token is a plain signed JWT: no
`jti`, no server-side session table, no revocation list, no refresh flow. The
web client stores it in `localStorage` under `nomad-token` (`web/src/lib/auth.tsx`).

That means:

- **`logout()` deletes the browser's copy and nothing else.** The token stays
  valid until it expires. So does changing a password. There is no way for a
  user, or for us, to end a session early.
- **Any script running on our origin can read it.** One XSS — ours, or a
  compromised dependency, or a bad CDN — yields up to 30 days of full account
  access from anywhere.

What an attacker holding a stolen token **can** do:

- read `last4`, `model`, `validatedAt` and usage for every configured provider;
- **delete** the victim's keys (denial of service, and the plaintext is gone
  from our side but still live at the vendor — §7);
- save their *own* key onto the victim's account;
- once F1–F4 land, spend the victim's provider credit through our features.

What they **cannot** do: read a plaintext key. No endpoint returns one, which is
the entire point of the vault and is what the leak tests defend. A session
compromise is a credit-burn and denial-of-service event, not a credential-theft
event.

**Accepted, with the fix named:** a short-lived access token plus a refresh
token, or a server-side session table keyed by `jti` with revocation on logout
and password change. Either is a real change to `auth/tokens.ts` and every
client call site, and neither belongs in F0. The 30-day TTL is a
convenience choice for a product with no users; it should shrink before it has
any.

## 5. `ai_cache` — settled by F2, the first feature to write to it

`cacheKey()` hashes `{ feature, destinationId, start, end, mode, model, provider,
options }`. There is no `userId` in it — deliberately, and asserted by a test —
and `ai_cache` has no `user_id` column, so the cache is **global**: the first
user to ask a given question pays for the answer, and every later user with a
matching tuple is served that stored answer verbatim.

That is the intended economics, and it is also a trust boundary. F0 wrote the
table and never crossed it. **F2 is the first writer**, and it answered the five
questions this section used to pose. What follows is the answer, not the
question.

### 5.1 Can user-controlled free text reach a cached payload? No, structurally.

Not "no, by convention". Three independent mechanisms, any one of which would
have to be dismantled deliberately:

1. `POST /api/ai/packing` reads exactly four scalars from the body —
   `destinationId`, `start`, `end`, `mode` — plus an optional `tripId` and
   `provider`, neither of which reaches a prompt. `destinationId` must resolve
   against `allDestinations`, our own catalogue. `mode` is an enum. The dates
   must match `YYYY-MM-DD`, survive an ISO round-trip, sit within a planning
   horizon and span at most 30 days. **There is no free-text field.**
2. `packingUserPrompt` takes a `PackingGrounding`, built from a `Destination`
   row. That type has no index signature, so a property smuggled onto a request
   body has no path into a prompt string that is not a compile error.
3. `parsePackingList` projects field by field into a freshly constructed object
   and returns nothing by reference. Anything the model emits outside the
   declared shape is dropped before `putCached` sees it.

Two canary tests hold this up: a POST carrying marker strings in extra body
fields must produce a prompt containing neither, and a stored payload containing
neither.

**Stated precisely, because the looser version would be wrong:** `start` and
`end` *are* caller-supplied strings and they *do* reach the prompt. They are
safe because they are pinned to `\d{4}-\d{2}-\d{2}`, ISO round-tripped, span
bounded and epoch bounded before they get there — not because they are absent.
The claim is "there is no free-text field", which is true; "no user input
reaches the prompt" would not be.

**The rule this establishes for F1, F3 and F4:** a feature may write to
`ai_cache` only while every prompt input comes from our catalogue. The first
feature that wants free-text steering — "make it lighter", "we have a toddler" —
must not cache, or must cache per user, and that is a design change rather than
a patch.

### 5.2 Is `provider` in the key? Yes, and required.

It was added by F2. Without it two vendors sharing a model id string collide,
and one user's Anthropic answer is served to a user who configured OpenAI.
Today that would be near-harmless because model ids happen to be vendor-unique;
it stops being harmless the moment an adapter with caller-chosen model names
exists — a local model, an OpenAI-compatible gateway — because then the user
picks the model *string*.

It is a **required** field rather than an optional one. Optional would have kept
every existing digest byte-identical, but it would also have left "pass a
provider" as something four separate route files each have to remember, with
nothing but review behind it. Every `AiFeature` is a model call, so every caller
has a provider.

Model ids cannot forge a boundary: `canonical()` runs every value through
`JSON.stringify`, so no amount of punctuation in a model string fakes a
delimiter. Asserted by a test.

### 5.3 Is a cached answer distinguishable from a fresh one? Yes.

The response carries `cached: boolean` and `generatedAt`, and the UI renders
"Generated 3 days ago · free, from cache" or "Generated just now · billed to
your provider". `usage.ts` already split `cachedCalls` from billed calls, so the
accounting was honest; now the surface is too.

`generatedAt` is normalised to ISO-8601 with a zone marker inside `getCached`,
because `datetime('now')` writes UTC with no marker and a browser reads that as
local time — a list generated a minute ago would otherwise read as hours old for
most of the world.

### 5.4 What is the TTL, and what bounds the table?

Per feature, declared beside the prompt it belongs to, because staleness is a
property of a particular prompt's answers rather than of the cache mechanism.
Packing chose **30 days**.

A packing list is a function of static repository data — the destination row, its
month climatology, the trip length, the mode — so it does not decay because the
world moved. Expiry exists only so a catalogue correction reaches users and so
one bad generation is not permanent, both of which operate on a scale of weeks.
The binding argument runs the other way: a cache hit is free, so a longer window
is strictly pro-user, and anything under a month re-bills the ordinary user who
reopens the tab as their date approaches.

A prompt change is **not** handled by the TTL. `PACKING_PROMPT_VERSION` travels
in `options.pv`, so bumping it invalidates every row instantly and deliberately.

Space is bounded by a per-feature sweep inside `putCached`'s transaction, keeping
the 2000 most recently written rows for that feature. Least-recently-*written*,
not least-recently-used: true LRU needs a `last_read_at` column, which means an
`ALTER TABLE` in a repo with no migration runner and turns every cache read into
a write.

### 5.5 There is still no integrity check on a payload — and one mitigation

Whoever triggers a miss writes the row everyone else reads. That is inherent to a
global cache, and it is only acceptable while §5.1 holds.

F2 adds one thing F0 did not have: **the cache-hit path re-runs the validator**
rather than trusting the stored row. A payload written under a prompt version
this build no longer understands, or edited straight into the SQLite file, is
treated as a miss and regenerated rather than being served with our UI's trust —
checkboxes, item keys and all — attached to it. It does not make the row
trustworthy; it bounds what an untrustworthy row can be.

### 5.6 The cache is a cross-user activity oracle, at a price

A user's *first* request for a tuple answering `cached: true`, with a
`generatedAt` older than that request, discloses that **some** other account has
already generated exactly that `(destination, start, end, mode, provider,
model)`, and roughly when.

No identity crosses: the answer is "somebody planned Spiti 12–18 March by bike",
never who. And probing is not free — a negative probe bills the prober a real
completion and writes the row it was testing for, so enumeration costs money and
destroys its own evidence.

**Accepted and disclosed here** rather than mitigated, because the two obvious
mitigations both cost more than the leak: hiding `cached` removes the honesty
that §5.3 exists for, and per-user first-seen tracking reintroduces the user
identity that keeping this table global was meant to avoid.

### 5.7 What F2 did *not* close: the eviction budget is shared

The 2000-row bound is **per feature, not per user**. One authenticated user
issuing 2000 distinct requests evicts everyone else's packing rows and makes
them pay again on their next visit.

It costs the attacker 2000 completions billed to their own key, and the route's
30/hour per-account limiter bounds the rate — but registration is not throttled,
so N accounts give 30N/hour. Fixing it properly needs a per-caller partition,
which needs a column, which needs a migration runner this repo does not have.

**Accepted, and named here rather than left to be rediscovered in F3.**

---

## 5A. `trip_packing` — per-user state beside a shared cache

F2 introduces the first table that holds per-user state derived from an AI
answer, which makes "the cache is global" and "ticks are private" adjacent
claims that must not blur.

- **`trip_packing` has no `user_id` column.** `trips.user_id` is the one owner; a
  copy would be a second source of truth that can disagree. Every write resolves
  ownership through `trips` in the same statement, so a non-owner's write changes
  zero rows and the route answers **404** — the same shape as the rest of
  `trips.ts`, and never a 403, so there is no existence oracle.
- **Tick state cannot reach `ai_cache`.** `PackingList` has no `checked` field at
  all, and the tick state is assembled *after* `putCached`. Asserted by a test
  that reads the stored payloads directly.
- **`syncTripPacking` re-checks ownership inside its own transaction.** The route
  resolves the trip and then awaits a vendor call; better-sqlite3 is synchronous,
  so that await is the only yield point in the request. A trip deleted in that
  window would otherwise have rows re-inserted for it after its cascade had run,
  leaving unreachable storage forever. Not a cross-user leak — `trips.id` is
  `AUTOINCREMENT`, so ids are never reused — but a broken invariant.
- **Deleting a trip removes its checklist**, explicitly and transactionally.
  `PRAGMA foreign_keys` is off, matching the existing bare `REFERENCES`, so the
  cascade is application code and is tested as such.

## 6. The throttle that exists, and what it does not cover

`POST /api/ai/keys` is limited to **10 saves per hour per account** — a sliding
window in an in-process `Map` (`ai/rateLimit.ts`, wired in `routes/ai-keys.ts`),
answering `429` with a `Retry-After`.

It exists because that route makes a live call to a vendor with a
caller-supplied credential, which makes it a free oracle for testing stolen API
keys, and because each attempt costs a ~60–90 ms scrypt derivation.

What it does **not** cover, stated so nobody assumes otherwise:

- **It is keyed on `user_id`, after authentication.** An attacker who can
  register accounts gets 10 attempts per account; registration itself is not
  throttled. The limiter raises the cost of bulk key-testing, it does not stop it.
- **It is per process and in memory.** Two instances mean two independent
  budgets, and a deploy resets every counter. Horizontal scaling requires a
  shared store — noted in the LLD, still true.
- **No other route is limited**, including `POST /api/auth/login` and
  `/register`. Password brute-forcing is a separate, currently unmitigated
  problem, and it reaches the vault through §4.

## 7. Deleting a key here does not revoke it at the vendor

`DELETE /api/ai/keys/:provider` removes the row and any preference pointing at
it, in one transaction. Our copy is gone immediately and irrecoverably.

**The credential itself is still live at Anthropic, Google or OpenAI.** Anyone
who obtained it — including whoever caused the user to delete it in the first
place — can still use it and still bill it. If a user is deleting a key because
they think it was exposed, the only action that actually helps is revoking it in
the provider's own console:

- Anthropic — console.anthropic.com → API keys
- Google AI Studio — aistudio.google.com → API keys
- OpenAI — platform.openai.com → API keys

**Open action, not yet done:** the delete confirmation in `ProviderKeyRow` and
the disclosure in `VaultNote` say what removal does on our side and are silent on
this. They should say it. Recorded here so the gap is a known one rather than an
oversight.

## 8. Residual risk register

| # | Risk | Status |
| --- | --- | --- |
| 1 | Host or process compromise exposes every key in plaintext | Accepted — inherent to a single-service architecture with no KMS |
| 2 | Rotating `NOMAD_MASTER_KEY` destroys every stored key; no `rotate()` | Accepted for F0 — §3 names the implementation and the operating rule |
| 3 | XSS yields 30 days of account access; sessions cannot be revoked | Accepted for F0 — attacker cannot read plaintext keys; can delete them and burn credit |
| 4 | Global `ai_cache` serves one user's answer to another | **Bounded** — settled by F2 in §5. Prompt inputs are catalogue-only and structurally enforced, `provider` is in the key, hits are re-validated, TTL is 30 days |
| 4a | One user's requests can evict every other user's cached rows | Accepted — §5.6. Costs the attacker 2000 paid completions; rate-bounded per account but registration is unthrottled |
| 9 | A feature route can burn a victim's provider credit through F2 | Bounded — 30 generations/hour/account, checked before the key is decrypted. Not a spend cap |
| 10 | `NOMAD_AI_FAKE` on a deployed host would serve fabricated answers from the shared cache | Closed — the process refuses to boot unless `NODE_ENV` explicitly says test or development, and never on a platform-marked host. Fails **closed** on an unrecognised host |
| 11 | The shared cache discloses that *someone* has planned a given trip tuple | Accepted — §5.6. No identity crosses; probing costs a paid completion and self-poisons the row |
| 12 | `trips` has no UNIQUE constraint, so concurrent creates leave duplicates | Accepted for F2 — pre-existing, and adding the index would fail at boot on any database that already holds duplicates. `packingStore` resolves deterministically to the lowest id |
| 13 | The tick endpoints are unthrottled | Accepted — each call is one small write plus a re-read, scoped to the caller's own trip, and the generation route in front of them is limited |
| 5 | Key-save throttle is per-account and per-process only | Accepted — raises cost, does not eliminate the oracle |
| 6 | Deleting a key here does not revoke it upstream | Accepted; UI copy gap is an open action (§7) |
| 7 | Non-production data is encrypted under a public key | Accepted by design; deployed hosts refuse it |
| 8 | No spend cap; usage is reported, not enforced | Accepted for F0 — out of scope, stated in the LLD |
