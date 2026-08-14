# Northstar Nomad — BYOK AI Planning Cluster (Design)

Date: 2026-08-14
Status: awaiting approval
Theme: **"Your keys, your copilot" — turn the pick into a plan.**

## Problem

The core loop today is: open the calendar → see a glowing free weekend →
click it → get three scored picks. Then it stops. The user knows *where* to
go and *why now*, but has nothing to act on: no itinerary, no packing list,
no budget, no way to ask for something the filter chips can't express.

The loop dead-ends at the moment of highest intent.

## Approach

Five features, one shared foundation. Users bring their own AI API key
(Anthropic, Google Gemini, or OpenAI); Northstar Nomad supplies the prompts,
the grounding data, and the UI. The product pays nothing per call, and the
user pays only for what they ask for.

| ID | Feature | Depends on |
| --- | --- | --- |
| F0 | BYOK Key Vault + provider abstraction | — |
| F1 | AI Trip Copilot (day-by-day itinerary) | F0 |
| F2 | Packing list generator | F0 |
| F3 | Budget estimator | F0 |
| F4 | Natural-language trip search | F0 |

F0 must merge before F1–F4 branch off it. F1–F4 are mutually independent and
can be built in parallel.

## Principles (binding on every PRD in this cluster)

1. **Structured output, never chat.** Every AI call returns JSON validated
   against a schema and renders as real UI — day cards, checkboxes, a budget
   table. No chat bubbles in this cluster. Conversational concierge is a
   later tier and a different interaction model.

2. **The engine still decides.** AI never invents destinations. In F4 the
   model translates language into *filters*; `recommend()` still ranks and
   picks. In F1–F3 the model is given the destination's real `monthScores`,
   `weather`, `budgetTier`, `tags`, and `idealDays` as grounding and told to
   use them.

3. **Degrade honestly.** No key configured → the panel explains what it would
   do and shows an "Add your key" CTA. Provider error → the specific reason
   ("your key is out of credits", "rate limited, retry in 30s"). Never a
   silent failure, never fabricated placeholder content.

4. **The plaintext key never leaves the vault.** It is never in a response
   body, never in a log line, never in an error message, never in a stack
   trace. The client only ever sees `{ provider, last4, model, validatedAt }`.

5. **Cache aggressively — it is the user's money.** Identical inputs must not
   re-bill the user. Every AI response is cached in SQLite keyed by a hash of
   (feature, destination, dates, mode, options, model).

6. **Every AI feature is testable without a network.** The provider layer is
   an interface with an injectable fake. CI never needs a real API key.

## Architecture

### Key storage: encrypted at rest (Model A)

```
POST /api/ai/keys { provider, apiKey }
        │
        ├─ validate: cheapest possible live call to the provider
        ├─ encrypt:  AES-256-GCM, key = scrypt(NOMAD_MASTER_KEY, userSalt)
        └─ store:    ai_keys(user_id, provider, ciphertext, iv, tag, last4)

GET /api/ai/keys  →  [{ provider, last4, model, validatedAt }]   ← never the key
```

`NOMAD_MASTER_KEY` is read from env. In production the server **refuses to
boot** without it. In development it falls back to a fixed dev value with a
loud warning, so `npm run dev` still works out of the box.

Alternatives considered and rejected:

- **Browser-only, direct to provider.** Server never sees the key, but
  Anthropic requires the `anthropic-dangerous-direct-browser-access` header,
  any XSS on a public app takes the key, prompt templates ship to the client,
  and — decisively — server-side caching becomes impossible, so every refresh
  re-bills the user.
- **Session proxy, nothing at rest.** Good privacy, but forces key re-entry on
  every device and forecloses background jobs.

Model A's cost is real: we become custodians of user API keys. It is accepted
because caching and cross-device continuity are worth more here, and because
principle 4 plus a boot-time master-key requirement bounds the exposure.

### Provider abstraction

```ts
export interface AiProvider {
  readonly id: "anthropic" | "gemini" | "openai";
  readonly defaultModel: string;
  /** Cheapest possible call that proves the key works. */
  validate(apiKey: string): Promise<ValidationResult>;
  /** Single-turn structured generation against a JSON schema. */
  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;
}
```

Three implementations (`anthropic.ts`, `gemini.ts`, `openai.ts`) plus
`fake.ts` for tests. Each maps its provider's native structured-output
mechanism — Anthropic tool-use, Gemini `responseSchema`, OpenAI
`response_format: json_schema` — onto one internal shape. Provider-specific
error codes normalise into a shared taxonomy:

| Internal code | HTTP | Meaning |
| --- | --- | --- |
| `no_key` | 428 | User has not configured a key for any provider |
| `invalid_key` | 401 | Provider rejected the credentials |
| `insufficient_credit` | 402 | Key valid, account out of funds |
| `rate_limited` | 429 | Includes `retryAfter` seconds when the provider gives one |
| `provider_error` | 502 | Everything else upstream |
| `bad_output` | 502 | Response failed schema validation after one retry |

Recommended default models, newest generation, overridable per user:
Anthropic `claude-sonnet-5`, Gemini `gemini-2.5-pro`, OpenAI `gpt-5`.

### Request path

```
route → requireAuth → loadUserKey → cache lookup ──hit──→ 200 (cached: true)
                                         │miss
                                         ↓
                              buildPrompt(grounding data)
                                         ↓
                              provider.complete(schema)
                                         ↓
                              validate JSON ──fail──→ retry once → bad_output
                                         │ok
                                         ↓
                              persist to ai_cache → 200 (cached: false)
```

### Schema

```sql
CREATE TABLE ai_keys (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  provider     TEXT    NOT NULL,
  ciphertext   BLOB    NOT NULL,
  iv           BLOB    NOT NULL,
  tag          BLOB    NOT NULL,
  salt         BLOB    NOT NULL,
  last4        TEXT    NOT NULL,
  model        TEXT,
  validated_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE ai_cache (
  cache_key  TEXT PRIMARY KEY,   -- sha256(feature|dest|start|end|mode|opts|model)
  feature    TEXT NOT NULL,
  payload    TEXT NOT NULL,      -- the validated JSON response
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  feature      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`ai_cache` is global rather than per-user on purpose: two users asking for a
Jaisalmer Sat–Mon itinerary should get the same answer, and the second one
should get it free. Nothing user-specific is ever written into a cached
payload — this is a hard constraint on every prompt in the cluster.

### File layout

```
server/src/ai/
  provider.ts        # AiProvider interface, error taxonomy
  providers/{anthropic,gemini,openai,fake}.ts
  vault.ts           # encrypt / decrypt / rotate
  cache.ts           # get / put / key derivation
  usage.ts           # token accounting
  prompts/{itinerary,packing,budget,search}.ts
server/src/routes/
  ai-keys.ts         # F0
  ai-itinerary.ts    # F1
  ai-packing.ts      # F2
  ai-budget.ts       # F3
  ai-search.ts       # F4
web/src/
  lib/ai.ts          # typed client for all /api/ai/* routes
  components/Ai/     # shared AiPanel, AiEmptyState, AiError, KeyPrompt
```

### Testing

Vitest + supertest, matching the existing 60-test suite. Every route gets:
happy path against `fake.ts`, `no_key` path, `invalid_key` path,
`bad_output` retry path, cache-hit path, and unauthenticated 401. The vault
gets round-trip encrypt/decrypt tests plus an explicit test asserting the
plaintext key appears in no response body. No test requires network access.

## Non-goals

- Conversational chat UI (later tier)
- Streaming responses (structured JSON renders at once; adds complexity for
  no user-visible gain here)
- Northstar-supplied keys or any billing relationship
- Live weather / pricing APIs (separate cluster, changes the engine itself)
- Fine-tuning, embeddings, or RAG

## Risks

| Risk | Mitigation |
| --- | --- |
| Custody of user API keys | AES-256-GCM at rest, master key required at boot, plaintext never egresses, documented threat model |
| Model invents a destination or a fake road | Grounding data injected into every prompt; F4 output constrained to the existing filter enum, unknown values dropped |
| Cost surprise for the user | Aggressive caching, per-feature token accounting surfaced in the profile, one call per explicit user action |
| Provider API drift across three vendors | One narrow interface, one adapter per provider, contract tests per adapter |
| Cached payload leaks one user's data to another | Prompts never receive user-identifying input; enforced by review and by a test asserting cache keys contain no user id |

## Open decisions for the approver

1. Which of F1–F4 to build after F0, and in what order.
2. Whether F0 ships all three providers at once or Anthropic first with the
   interface in place for the other two.
