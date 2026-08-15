# Threat model — the BYOK key vault

Scope: feature **F0**, the storage and use of user-supplied AI provider API
keys (`server/src/ai/*`, `server/src/routes/ai-keys.ts`, the profile UI).
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

## 5. `ai_cache` — the question F1 must settle before it writes a single row

`cacheKey()` hashes `{ feature, destinationId, start, end, mode, model, options }`.
There is no `userId` in it — deliberately, and asserted by a test — and there is
no `provider` in it either. `ai_cache` has no `user_id` column, so the cache is
**global**: the first user to ask a given question pays for the answer, and every
later user with a matching tuple is served that stored answer verbatim.

That is the intended economics. It is also a trust boundary, and F0 has not
crossed it: **`cache.ts` has zero callers today.** F1 is the first thing that
will write to that table, and these are the questions it has to answer first.

1. **Can any user-controlled free text reach the cached payload?** If a prompt
   ever includes text the asker typed, the cache turns into a distribution
   channel: one crafted request, one poisoned row, served to everyone who asks
   the same question afterwards, with our UI's trust attached to it. If prompt
   inputs are restricted to our own catalogue (a destination id, dates, a mode),
   the blast radius is a wrong answer rather than an attacker-authored one.
   **Recommended default: cache only when every prompt input comes from our
   catalogue.**
2. **Should `provider` join the key?** As written, two vendors that share a model
   id string collide, and one user's Anthropic answer can be served to a user who
   configured OpenAI. `model` is in the key, so today the collision is mostly
   *between users on the same model*, and it is close to harmless — model ids
   happen to be vendor-unique in practice. It stops being harmless the moment an
   adapter with arbitrary model names exists (a local model, an
   OpenAI-compatible gateway), because then a user picks the model *string*.
   Adding `provider` costs one line and removes the question.
3. **Is a cached answer distinguishable from a fresh one, to the user?**
   `usage.ts` already splits `cachedCalls` from billed calls, so the accounting
   is honest. The UI should be too, if the answer might be days old.
4. **What is the TTL?** `getCached` accepts `maxAgeMs` but each caller chooses,
   and the default is "forever". F1 should pick a bound per feature rather than
   leaving that to whoever writes the fourth feature.
5. **There is no integrity check on a payload.** Whoever triggers a miss writes
   the row that everyone else reads. That is inherent to a global cache; it is
   only acceptable while (1) holds.

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
| 4 | Global `ai_cache` serves one user's answer to another | Not yet realised — zero callers; F1 must settle §5 before writing |
| 5 | Key-save throttle is per-account and per-process only | Accepted — raises cost, does not eliminate the oracle |
| 6 | Deleting a key here does not revoke it upstream | Accepted; UI copy gap is an open action (§7) |
| 7 | Non-production data is encrypted under a public key | Accepted by design; deployed hosts refuse it |
| 8 | No spend cap; usage is reported, not enforced | Accepted for F0 — out of scope, stated in the LLD |
