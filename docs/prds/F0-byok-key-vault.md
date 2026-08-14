# PRD F0 — BYOK Key Vault & Provider Abstraction

| | |
| --- | --- |
| **Status** | Awaiting approval |
| **Branch** | `feat/f0-byok-key-vault` |
| **Depends on** | Nothing |
| **Blocks** | F1, F2, F3, F4 |
| **Size** | Large (foundation) |

## Summary

Let a user paste their own Anthropic, Gemini, or OpenAI API key into their
profile. Store it encrypted, validate it against the live provider, and expose
one internal interface so every later AI feature is "one route, one prompt".

## Problem

Northstar Nomad has no AI features and no way to pay for them. Running a
shared key means the product absorbs unbounded per-user cost for a free tool
with no billing relationship. Bring-your-own-key removes the cost ceiling
entirely: the user's spend is their own, capped by their own provider limits,
and the product ships AI features on day one without a payment integration.

Nothing in the cluster can be built until this exists.

## Users & jobs

- *A user who already pays for Claude* wants to reuse that subscription's API
  access here without creating another account or entering a card.
- *A privacy-minded user* wants to know exactly where their key is stored,
  what it is used for, and how to remove it in one click.
- *A user with no key* must never hit a broken screen — they should understand
  what they are missing and how to get it.

## Goals

1. Add, replace, and delete a key for each of three providers.
2. Validate a key at save time with the cheapest possible live call and show a
   clear result within ~3 seconds.
3. Encrypt at rest; the plaintext key never appears in any response, log, or
   error.
4. One `AiProvider` interface that F1–F4 code against without knowing the
   vendor.
5. Per-feature token usage visible to the user in their profile.

## Non-goals

- Northstar-supplied keys, trials, or any billing
- Team/shared keys
- Key rotation reminders or expiry tracking
- Local models (Ollama, LM Studio) — the interface should not preclude them,
  but no adapter ships here

## Functional requirements

### Backend

**`POST /api/ai/keys`** — auth required.
Body `{ provider: "anthropic"|"gemini"|"openai", apiKey: string, model?: string }`.
Validates the key live, then encrypts and upserts. Returns
`{ provider, last4, model, validatedAt }` — never the key.
Errors: `400` malformed provider or key shape, `401` provider rejected the
key, `502` provider unreachable.

**`GET /api/ai/keys`** — auth required. Returns the array of configured keys
in redacted form. Empty array is a valid, non-error response.

**`DELETE /api/ai/keys/:provider`** — auth required. Removes the row. `204` on
success, `404` if nothing was configured.

**`GET /api/ai/usage`** — auth required. Returns per-feature totals:
`{ feature, calls, cachedCalls, inputTokens, outputTokens }[]`.

**Encryption.** AES-256-GCM. Per-user random 16-byte salt; content key =
`scrypt(NOMAD_MASTER_KEY, salt, 32)`. Store ciphertext, iv, auth tag, salt,
and `last4` separately. `NOMAD_MASTER_KEY` required at boot when
`NODE_ENV === "production"`; the server exits with a clear message if absent.
Development falls back to a fixed dev key and logs a prominent warning.

**Provider adapters.** `validate()` uses the smallest real call each vendor
offers — Anthropic a 1-token message, Gemini a `models.get`, OpenAI a
`GET /v1/models`. `complete<T>()` maps each vendor's native structured-output
mechanism onto one internal shape and normalises errors into the shared
taxonomy (`no_key`, `invalid_key`, `insufficient_credit`, `rate_limited`,
`provider_error`, `bad_output`).

**Selection.** A user may configure more than one provider. `loadUserKey()`
picks the user's explicitly preferred provider if set, else the most recently
validated one.

### Frontend

A **"AI & Keys"** section on the existing profile page:

- One row per provider — logo mark, connection state, `last4`, model, and when
  it was last validated.
- Add-key form: password-type input, paste-friendly, inline validation
  feedback ("✓ Connected — Claude Sonnet 5" / "✗ That key was rejected").
- Delete with confirmation.
- A short, plain-language note on where the key is stored and what it is used
  for. No dark patterns, no buried disclosure.
- A usage summary: calls and tokens per feature, with cached calls shown
  separately so the saving is visible.

A shared `<KeyPrompt />` component that F1–F4 render when the user has no key:
explains the specific feature's value and links to the profile section.

## Success criteria

- A user can paste a key and see a confirmed connection in under 30 seconds.
- Grepping the entire response surface for the plaintext key yields nothing —
  asserted by a test, not by inspection.
- F1 can be built afterward touching zero provider-specific code.
- Server refuses to start in production without `NOMAD_MASTER_KEY`.

## Test plan

- Vault: encrypt→decrypt round trip; wrong master key fails to decrypt;
  tampered ciphertext fails the GCM auth tag.
- Routes: save/list/delete happy paths; unauthenticated 401; invalid provider
  400; provider-rejects-key 401.
- **Leak test:** save a key, then call every `/api/ai/*` endpoint and assert
  the plaintext appears in no response body.
- Adapters: each provider's error shapes map to the correct internal code,
  driven by recorded fixtures — no network in CI.
- Boot: production without `NOMAD_MASTER_KEY` exits non-zero.

## Rollout

Ships dark in the sense that no feature consumes it yet. Merging F0 alone
changes only the profile page.

## Micro-task breakdown (for the LLD & coding agents)

1. `ai_keys` / `ai_cache` / `ai_usage` tables + migration
2. `vault.ts` encrypt/decrypt + tests
3. `provider.ts` interface + error taxonomy + `fake.ts`
4. Anthropic adapter + fixture tests
5. Gemini adapter + fixture tests
6. OpenAI adapter + fixture tests
7. `POST/GET/DELETE /api/ai/keys` + tests
8. `loadUserKey` middleware + tests
9. `cache.ts` + `usage.ts` + tests
10. `GET /api/ai/usage` + tests
11. `web/src/lib/ai.ts` typed client
12. Profile "AI & Keys" section UI
13. Shared `<KeyPrompt />` component
14. Docs: README env vars + threat model note

Each is one small PR into `feat/f0-byok-key-vault`.
