# LLD — F0 BYOK Key Vault & Provider Abstraction

Low-level design for [PRD F0](../../prds/F0-byok-key-vault.md). Produced by the `lld-planner`
agent, reviewed and accepted. Drives 14 phase branches into `feat/f0-byok-key-vault`.

## 1. Assumptions

- **Real SQLite.** Tables append to the existing `db.exec` block in `server/src/db.ts` with
  `CREATE TABLE IF NOT EXISTS`. No migration tool; a running `data.sqlite` gains the tables on
  next boot.
- **Real provider adapters ship.** `anthropic.ts`, `gemini.ts`, `openai.ts` call live HTTPS
  endpoints via global `fetch`. `fake.ts` implements the same interface and is what route tests
  inject; adapter tests stub `globalThis.fetch` against recorded fixtures. CI never touches the
  network; production never touches the fake.
- **Auth already exists.** `requireAuth` sets `req.userId`. AI routes reuse it verbatim.
- **No new dependencies.** Crypto is `node:crypto` (`scryptSync`, `randomBytes`,
  `createCipheriv`). HTTP is global `fetch`. `better-sqlite3` is synchronous — repository
  functions are sync; only adapters are async.
- **No `dotenv`.** `NOMAD_MASTER_KEY` comes from the real process env.
- **Web has no test runner.** Frontend phases are verified by `npm run typecheck --workspace=web`
  and `npm run build --workspace=web`. F0 does not add a web test setup.
- **Web cannot import server types.** AI DTOs are duplicated in `web/src/lib/ai.ts` with a
  comment pointing at the server source of truth, matching `web/src/lib/types.ts`.
- **`foreign_keys` pragma stays off.** `REFERENCES users(id)` is declarative, matching `trips`.
  Enabling it would retroactively change existing behavior.
- Single-node server; the per-process save rate limiter is best-effort and acceptable at this scale.
- All three providers ship at once.

### Accepted deviations from the PRD

| # | PRD says | Decision | Why |
| --- | --- | --- | --- |
| D1 | `POST` returns flat `{ provider, last4, model, validatedAt }` | `{ key: RedactedKey }` | Every existing route wraps (`{ trip }`, `{ user }`, `{ trips }`). |
| D2 | `complete<T>(req: CompletionRequest<T>)` | `complete<T>(req): Promise<CompletionResult<T>>` | The schema is a runtime JSON Schema, not a TS type. Generic belongs on the return. |
| D3 | only `routes/ai-keys.ts` | also `routes/ai-usage.ts` | Phases 7 and 10 are separate PRs — separate files, no merge conflict. |
| D4 | per-user salt | per-**row** salt, regenerated every save | Strictly stronger; the schema already puts `salt` on `ai_keys`. |
| D5 | POST errors 400/401/502 | adds 402 `insufficient_credit`, 429 `rate_limited` | Validation calls really return these. Key is **not** saved on 402. |

## 2. Modules affected

### Data layer

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `server/src/db.ts` | Modified | Append `ai_keys`, `ai_cache`, `ai_usage` + indexes to the existing `db.exec` block. |
| `server/src/ai/master-key.ts` | New | Resolve `NOMAD_MASTER_KEY`; dev fallback + warning; production throw. |
| `server/src/ai/master-key.test.ts` | New | prod-without-key throws; dev falls back; explicit key wins. |
| `server/src/ai/vault.ts` | New | `encryptKey` / `decryptKey`. scrypt + AES-256-GCM. Only module that sees plaintext at rest. |
| `server/src/ai/vault.test.ts` | New | Round trip, wrong master key, tampered ciphertext/tag. |
| `server/src/ai/keys.ts` | New | `ai_keys` repository: `upsertKey`, `listKeys`, `deleteKey`, `loadUserKey`. |
| `server/src/ai/keys.test.ts` | New | Upsert replaces, selection order, decrypt-failure → null, per-user isolation. |
| `server/src/ai/cache.ts` | New | `cacheKey` derivation + `getCached` / `putCached`. |
| `server/src/ai/cache.test.ts` | New | Determinism, key-order independence, no user id in key, TTL expiry. |
| `server/src/ai/usage.ts` | New | `recordUsage` + `usageByFeature`. |
| `server/src/ai/usage.test.ts` | New | Aggregation math, cached rows counted separately, per-user scoping. |

### Domain / provider layer

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `server/src/ai/provider.ts` | New | `AiProvider` interface, `ProviderId`, `AiError` + `AiErrorCode`, `AI_ERROR_STATUS`, request/result types, key-shape regexes. |
| `server/src/ai/http.ts` | New | `fetchJson()` — timeout-bounded fetch shared by all adapters. Plus `scrubKey()`. |
| `server/src/ai/http.test.ts` | New | Timeout → `provider_error`; non-JSON body handled; `scrubKey` redacts. |
| `server/src/ai/providers/registry.ts` | New | `getProvider(id)`; `overrideProvider` / `resetProviders` test seam. |
| `server/src/ai/providers/fake.ts` | New | Deterministic in-process `AiProvider` for route tests. |
| `server/src/ai/providers/anthropic.ts` | New | Real adapter: `/v1/messages`, tool-use structured output. |
| `server/src/ai/providers/gemini.ts` | New | Real adapter: `models.get` validate, `generateContent` + `responseSchema`. |
| `server/src/ai/providers/openai.ts` | New | Real adapter: `GET /v1/models` validate, `response_format: json_schema`. |
| `server/src/ai/providers/*.test.ts` | New | Fixture-driven error mapping + happy path, `fetch` stubbed. |
| `server/src/ai/providers/__fixtures__/*.ts` | New | Recorded response bodies as TS consts (avoids ESM JSON import assertions). |

### Transport layer

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `server/src/ai/require-key.ts` | New | `requireAiKey` middleware: attaches `req.aiKey`, else 428 `no_key`. Ships for F1–F4. |
| `server/src/ai/require-key.test.ts` | New | 401 unauth, 428 no key, passes through with key. |
| `server/src/routes/ai-keys.ts` | New | `POST` / `GET` `/api/ai/keys`, `DELETE /api/ai/keys/:provider`. |
| `server/src/routes/ai-keys.test.ts` | New | Happy paths, every error status, **the leak test**. |
| `server/src/routes/ai-usage.ts` | New | `GET /api/ai/usage`. |
| `server/src/routes/ai-usage.test.ts` | New | Aggregated shape, empty array, 401, per-user isolation. |
| `server/src/app.ts` | Modified | Register `aiKeysRouter` and `aiUsageRouter`. |
| `server/src/index.ts` | Modified | `assertMasterKeyAtBoot()` before `listen`; exit 1 on failure. |

### Web

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `web/src/lib/ai.ts` | New | Typed client for `/api/ai/*` + duplicated DTOs. |
| `web/src/components/Ai/KeysSection.tsx` | New | "AI & Keys" panel: loads keys, renders provider rows, owns add/delete state. |
| `web/src/components/Ai/KeyRow.tsx` | New | One provider row: mark, state, `last4`, model, validated-at, delete-with-confirm. |
| `web/src/components/Ai/AddKeyForm.tsx` | New | Password input, model override, inline validate feedback, disclosure copy. |
| `web/src/components/Ai/UsageSummary.tsx` | New | Per-feature calls/tokens table, cached calls in their own column. |
| `web/src/components/Ai/KeyPrompt.tsx` | New | Shared no-key empty state for F1–F4. |
| `web/src/components/Ai/index.ts` | New | Barrel so F1–F4 import from one path. |
| `web/src/pages/ProfilePage.tsx` | Modified | Render `<KeysSection />` + `<UsageSummary />`; add `id="ai-keys"` anchor. |

### Config & docs

| File | New/Modified | Responsibility |
| --- | --- | --- |
| `render.yaml` | Modified | `NOMAD_MASTER_KEY` with `generateValue: true`. |
| `.env.example` | New | `JWT_SECRET`, `NOMAD_MASTER_KEY`, `NOMAD_DB`, `PORT`. |
| `README.md` | Modified | Env-var table, `/api/ai/*` rows, BYOK paragraph, correct the "No database" line. |
| `docs/THREAT-MODEL.md` | New | Key custody: what we store, what an attacker gets, why Model A. |

## 3. Data model

```sql
CREATE TABLE IF NOT EXISTS ai_keys (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  provider     TEXT    NOT NULL
    CHECK (provider IN ('anthropic','gemini','openai')),
  ciphertext   BLOB    NOT NULL,
  iv           BLOB    NOT NULL,
  tag          BLOB    NOT NULL,
  salt         BLOB    NOT NULL,
  last4        TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  validated_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key  TEXT PRIMARY KEY,
  feature    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_cache(created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  feature       TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached        INTEGER NOT NULL DEFAULT 0 CHECK (cached IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, feature);
```

- **Encrypted:** `ciphertext` only. `iv`, `tag`, `salt` are non-secret by design. `last4` is
  deliberately plaintext — the UI needs it.
- **Unique:** `PRIMARY KEY (user_id, provider)` — save is an upsert, so "replace a key" needs no
  separate endpoint.
- `model` is `NOT NULL`; the route fills the provider default when the body omits it.
- `is_preferred`: at most one row per user set to 1, enforced in a `db.transaction` on write.
- `ai_cache` is **global, not per-user** — it has no `user_id` column, which makes cross-user
  leakage structurally impossible to write by accident.
- `ai_usage.cached = 1` rows carry 0 tokens; they exist so the user can see money saved.
- better-sqlite3 binds and returns `Buffer` for BLOB columns — no base64 hop.

## 4. Interfaces & types

`server/src/ai/provider.ts`:

```ts
export type ProviderId = "anthropic" | "gemini" | "openai";
export const PROVIDER_IDS: readonly ProviderId[];

export type AiErrorCode =
  | "no_key" | "invalid_key" | "insufficient_credit"
  | "rate_limited" | "provider_error" | "bad_output";

export const AI_ERROR_STATUS: Record<AiErrorCode, number>;

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryAfter?: number;      // seconds, only for rate_limited
  constructor(code: AiErrorCode, message: string, retryAfter?: number);
}

export interface ValidationResult {
  ok: boolean;
  model: string;                     // the model actually probed
  code?: AiErrorCode;                // present iff !ok
  message?: string;                  // human copy, already key-scrubbed
  retryAfter?: number;
}

export interface CompletionRequest {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  schema: JsonSchema;                // vendor-neutral JSON Schema subset
  maxOutputTokens?: number;          // default 4096
  timeoutMs?: number;                // default 60_000
}

export interface CompletionResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly id: ProviderId;
  readonly defaultModel: string;
  validate(apiKey: string, model?: string): Promise<ValidationResult>;
  complete<T>(req: CompletionRequest): Promise<CompletionResult<T>>;
}

export const KEY_SHAPE: Record<ProviderId, RegExp>;
export const DEFAULT_MODEL: Record<ProviderId, string>;
```

`KEY_SHAPE` is **loose on purpose** — prefix hint + charset + length, so a future key format is
not rejected by us before the provider ever sees it:

- `anthropic`: `/^sk-ant-[A-Za-z0-9_-]{16,200}$/`
- `openai`: `/^sk-[A-Za-z0-9_-]{16,200}$/`
- `gemini`: `/^[A-Za-z0-9_-]{20,200}$/`

`DEFAULT_MODEL`: `anthropic → "claude-sonnet-5"`, `gemini → "gemini-2.5-pro"`,
`openai → "gpt-5"`.

### Implementations

| Impl | Ships? | validate() | complete() structured output | Usage fields |
| --- | --- | --- | --- | --- |
| `anthropicProvider` | yes, live HTTP | `POST /v1/messages`, `max_tokens: 1`, `x-api-key` + `anthropic-version: 2023-06-01` | single tool `emit` with `input_schema`, `tool_choice: {type:"tool",name:"emit"}` | `usage.input_tokens` / `output_tokens` |
| `geminiProvider` | yes, live HTTP | `GET /v1beta/models/{model}` with `x-goog-api-key` | `responseMimeType: "application/json"` + `responseSchema` | `usageMetadata.promptTokenCount` / `candidatesTokenCount` |
| `openaiProvider` | yes, live HTTP | `GET /v1/models`, `Authorization: Bearer` | `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}` | `usage.prompt_tokens` / `completion_tokens` |
| `fakeProvider(script?)` | **tests only** | scripted | echoes a canned object; can emit schema-invalid JSON once | fixed counts |

```ts
export interface FakeScript {
  validate?: ValidationResult | AiErrorCode;   // code shorthand => ok:false
  complete?: unknown | AiErrorCode;
  badOutputOnce?: boolean;
  calls: { validate: number; complete: number };
}
export function fakeProvider(script?: Partial<FakeScript>): AiProvider & { script: FakeScript };
```

```ts
// registry.ts
export function getProvider(id: ProviderId): AiProvider;
export function overrideProvider(id: ProviderId, impl: AiProvider): void;  // tests only
export function resetProviders(): void;
```

Routes import `getProvider` only — no route ever imports a concrete adapter. That is the
"F1 touches zero provider-specific code" guarantee.

## 5. Error taxonomy

`AI_ERROR_STATUS` is the single mapping table; no route hardcodes these numbers.

| Code | HTTP | Meaning | Typical trigger |
| --- | --- | --- | --- |
| `no_key` | 428 | No usable key for any provider | `loadUserKey()` null, or every row failed to decrypt |
| `invalid_key` | 401 | Provider rejected the credentials | Anthropic 401 `authentication_error`; OpenAI 401 `invalid_api_key`; Gemini 400 `API_KEY_INVALID` / 403 `PERMISSION_DENIED` |
| `insufficient_credit` | 402 | Key authentic, account cannot pay | Anthropic 400 "credit balance is too low"; OpenAI 429 `insufficient_quota`; Gemini 403 with billing detail |
| `rate_limited` | 429 | Throttled; `retryAfter` when supplied | any vendor 429 not classified as quota |
| `provider_error` | 502 | 5xx, network failure, timeout, unparseable body | Anthropic 529 overloaded; fetch throw; `AbortSignal.timeout` |
| `bad_output` | 502 | Model output failed schema validation after one retry | F1–F4 only; unreachable in F0 |

Rules:

- A 401 from `POST /api/ai/keys` means *the provider* rejected the key — distinct from
  `requireAuth`'s 401. The body carries `code: "invalid_key"`. **`web/src/lib/auth.tsx` clears
  the session on any 401**, so `saveKey` must not route its 401 through `authFetch` — it uses
  its own fetch with an explicit `Authorization` header.
- `retryAfter` goes in the JSON body only, never as an invented header.
- Every message crossing the boundary passes through `scrubKey(msg, apiKey)`.

```ts
interface ApiError { error: string; code?: AiErrorCode; retryAfter?: number }
```

## 6. API contract

Both routers do `router.use("/api/ai", requireAuth)` exactly like `tripsRouter`.

```ts
interface RedactedKey {
  provider: ProviderId;
  last4: string;
  model: string;
  validatedAt: string | null;
  preferred: boolean;
  createdAt: string;
}

interface SaveKeyRequest {
  provider: ProviderId;
  apiKey: string;
  model?: string;
  preferred?: boolean;
}

interface UsageRow {
  feature: string;
  calls: number;        // total, cached included
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}
```

### `POST /api/ai/keys`

Auth required. Body `SaveKeyRequest`. Flow: shape-validate → `getProvider(provider).validate()`
→ live HTTPS → on ok, `encryptKey` → upsert → `validated_at = datetime('now')`.
`201` → `{ key: RedactedKey }`.

| Status | `code` | Trigger |
| --- | --- | --- |
| 400 | — | provider not in enum; `apiKey` missing/blank/>512 chars/fails `KEY_SHAPE`; `model` fails `/^[A-Za-z0-9._-]{1,64}$/` |
| 401 | — | no/invalid bearer token |
| 401 | `invalid_key` | provider rejected the key |
| 402 | `insufficient_credit` | key authentic, account out of funds — **row not written** |
| 429 | `rate_limited` | provider throttled, or our save limiter tripped |
| 502 | `provider_error` | provider unreachable / 5xx / timed out |

### `GET /api/ai/keys`

Auth required. `200` → `{ keys: RedactedKey[] }`. Empty array is success, never 404. Selects
**explicit columns only** — never `SELECT *` on `ai_keys`. `401` unauthenticated.

### `DELETE /api/ai/keys/:provider`

Auth required. `204` no body. `400` provider not in enum. `401` unauthenticated. `404` when
`info.changes === 0` — same IDOR-masking pattern as `trips.ts`.

### `GET /api/ai/usage`

Auth required. `200` → `{ usage: UsageRow[] }`, ordered by `feature`. Empty array for a new
user. `401` unauthenticated. No provider call.

## 7. Key logic

### `master-key.ts`

```ts
export class MasterKeyMissingError extends Error {}
export function resolveMasterKey(env?: NodeJS.ProcessEnv): string;
export function assertMasterKeyAtBoot(env?: NodeJS.ProcessEnv): void;
```

If `env.NOMAD_MASTER_KEY` is a non-empty trimmed string, return it. Otherwise if
`NODE_ENV === "production"` throw `MasterKeyMissingError`; else `console.warn` once
(module-level flag, suppressed in test) and return the fixed dev constant. `index.ts` catches,
prints `NOMAD_MASTER_KEY is required in production — generate one with:
openssl rand -base64 48`, and `process.exit(1)`. Env is read per call, never cached, so tests
can mutate `process.env`.

### `vault.ts`

```ts
export interface SealedKey {
  ciphertext: Buffer; iv: Buffer; tag: Buffer; salt: Buffer; last4: string;
}
export class VaultDecryptError extends Error {}
export function encryptKey(plaintext: string): SealedKey;
export function decryptKey(sealed: Omit<SealedKey, "last4">): string;
```

`encryptKey` — `salt = randomBytes(16)`, `iv = randomBytes(12)`,
`dek = scryptSync(resolveMasterKey(), salt, 32, { maxmem: 64 * 1024 * 1024 })`,
`createCipheriv("aes-256-gcm", dek, iv)`, concat `update`+`final`, `getAuthTag()`,
`last4 = plaintext.slice(-4)`. Never logs.

`decryptKey` — re-derive from stored `salt`, `createDecipheriv`, `setAuthTag(tag)`, concat to
utf8. Any throw is caught and rethrown as
`VaultDecryptError("stored key could not be decrypted")` — the original error, the ciphertext,
and any partial plaintext are discarded. ~60–100 ms per scrypt call; two per save, one per AI
request.

### `keys.ts`

```ts
export interface LoadedKey { provider: ProviderId; apiKey: string; model: string }
export function loadUserKey(userId: number, prefer?: ProviderId): LoadedKey | null;
export function upsertKey(args: {
  userId: number; provider: ProviderId; apiKey: string; model: string; preferred: boolean;
}): RedactedKey;
export function listKeys(userId: number): RedactedKey[];
export function deleteKey(userId: number, provider: ProviderId): boolean;
```

`loadUserKey` — `SELECT ... WHERE user_id = ?` (plus `AND provider = ?` when `prefer` given),
`ORDER BY is_preferred DESC, COALESCE(validated_at,'') DESC, created_at DESC LIMIT 1`. On
`VaultDecryptError`, log a warning carrying `user_id` + provider only and return `null`, so the
caller degrades to `no_key` and the user re-pastes — the master-key-rotation path.

`upsertKey` runs in a `db.transaction`: `INSERT ... ON CONFLICT(user_id, provider) DO UPDATE
SET ...`, and when `preferred` is true, first
`UPDATE ai_keys SET is_preferred = 0 WHERE user_id = ? AND provider != ?`.

### `cache.ts`

```ts
export interface CacheKeyInput {
  feature: string; provider: ProviderId; model: string;
  params: Record<string, unknown>;   // never user data
}
export function cacheKey(input: CacheKeyInput): string;      // 64-char sha256 hex
export function getCached<T>(key: string, maxAgeDays?: number): T | null;
export function putCached(key: string, feature: string, payload: unknown): void;
```

`cacheKey` — canonicalise depth-first, drop `undefined`, sort object keys, leave arrays in
order, `JSON.stringify`, `sha256` hex. Key-order-independent and stable across processes.
`getCached` — `WHERE cache_key = ? AND created_at > datetime('now', ?)` with `-30 days`
default. `putCached` upserts and refreshes `created_at`.

`CacheKeyInput` has no `userId` field and `ai_cache` has no `user_id` column, so a cross-user
leak requires actively putting user data into `params`.

### `usage.ts`

```ts
export function recordUsage(row: {
  userId: number; feature: string; provider: ProviderId; model: string;
  inputTokens?: number; outputTokens?: number; cached?: boolean;
}): void;
export function usageByFeature(userId: number): UsageRow[];
```

`usageByFeature` — `SELECT feature, COUNT(*) AS calls, SUM(cached) AS cachedCalls,
COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
FROM ai_usage WHERE user_id = ? GROUP BY feature ORDER BY feature`.

### `require-key.ts`

```ts
export interface AiRequest extends AuthedRequest { aiKey?: LoadedKey }
export function requireAiKey(req: AiRequest, res: Response, next: NextFunction): void;
```

Reads `req.userId`, calls `loadUserKey`, attaches `req.aiKey`, or responds
`428 { error: "add an AI key in your profile to use this", code: "no_key" }`.

## 8. Security, validation, edge cases

### Must never appear in a response, log, or error

- The plaintext `apiKey`. Enforced by: explicit-column `SELECT`s so ciphertext never enters a
  route handler's scope; `scrubKey()` on every provider-sourced message; adapters never putting
  request `init`/headers into a thrown error; and the phase-7 leak test.
- No request-body logging on `/api/ai/keys` — none exists today; do not add one.
- `VaultDecryptError` messages carry no ciphertext, no partial plaintext, no salt.
- Only `last4` is ever exposed — never a prefix, a length, or a masked-middle form.

### Validation

- `provider` ∈ enum, else 400 (plus a DB `CHECK` as defence in depth).
- `apiKey`: string, trimmed, non-empty, ≤512 chars, matches `KEY_SHAPE[provider]` — checked
  **before** any outbound call.
- `model`: optional, `/^[A-Za-z0-9._-]{1,64}$/`. Absent → `DEFAULT_MODEL[provider]`.
- `preferred`: optional boolean.
- Validation timeout: `AbortSignal.timeout(8000)` → `provider_error`.

### Authorization

- Every statement filters `WHERE user_id = ?`. Only `ai_cache` reads are global, and they
  contain no user data.
- `DELETE` returns 404 (not 403) when `changes === 0`.
- `requireAuth` runs at router level, so a new endpoint cannot be added unauthenticated by
  omission.

### Edge cases

| Case | Behavior |
| --- | --- |
| Valid JWT, user row deleted | Explicit `SELECT id FROM users WHERE id = ?` guard in `POST` → 401 "account no longer exists" |
| `NOMAD_MASTER_KEY` rotated | Rows fail GCM auth → `loadUserKey` null → 428. `GET` still lists rows (`last4` plaintext); UI prompts a re-paste. Bulk re-encrypt out of scope. |
| Same key saved twice | Upsert; new salt + IV each time. No 409. |
| Two providers, neither preferred | Most recently validated wins. |
| Preferred key fails to decrypt | Return null rather than silently falling back — surfacing beats hiding. |
| 200 with unparseable body | `provider_error`, not a crash. |
| Save-endpoint abuse (key-validation oracle) | In-memory per-user limiter, 10 saves/hour → 429. Per-process, best-effort. |
| Concurrent saves, same (user, provider) | Synchronous better-sqlite3 + transaction; last writer wins. |
| `data.sqlite` on disk | Anyone with the file **and** the env var can decrypt. Stated in `docs/THREAT-MODEL.md`. |

## 9. Build order — 14 phases

Each phase is one branch and one PR into `feat/f0-byok-key-vault`. Every phase ends green:
`npm test --workspace=server`, `npm run typecheck --workspace=server`,
`npm run typecheck --workspace=web`.

Deviations from the PRD's micro-task list, and why:

1. **Phase 2 absorbs the boot guard** — the "server refuses to start without
   `NOMAD_MASTER_KEY`" criterion should be true the moment the vault exists, not 12 phases later.
2. **Phase 3 absorbs `http.ts` and `registry.ts`** — phases 4/5/6 all need them.
3. **Phase 7 absorbs the `keys.ts` repository** as its first commit; the routes need it. Phase 8
   then only builds the middleware.
4. **Phase 9 is two independent commits** (cache, usage) — they share nothing.
5. **Phase 14 is split** — the README env-var line lands in phase 2; only the threat model and
   API-table rows wait for 14.
6. 4/5/6 are mutually independent. 11/12/13 depend only on 7 and 10.

### Phase 1 — `ai_keys` / `ai_cache` / `ai_usage` tables

- **Files:** `server/src/db.ts` (M), `server/src/db.test.ts` (N)
- **Depends on:** —
- **Acceptance:** Three tables + two indexes created on boot. Existing tests still pass.
- **Tests assert:** `PRAGMA table_info(ai_keys)` returns the expected columns; PK is
  `(user_id, provider)`; the `provider` CHECK rejects `'grok'`; duplicate `(user_id, provider)`
  raises.
- **Commits:** (1) tables + indexes; (2) schema assertions; (3) `.gitignore` sqlite artefacts.

### Phase 2 — `vault.ts` + master key + boot guard

- **Files:** `server/src/ai/master-key.ts` + test, `server/src/ai/vault.ts` + test (N);
  `server/src/index.ts`, `README.md`, `render.yaml` (M); `.env.example` (N)
- **Depends on:** —
- **Acceptance:** Round trip works. Prod without `NOMAD_MASTER_KEY` throws. Dev warns once and
  works. `npm run dev` still boots with no env changes.
- **Tests assert:** round trip returns the key exactly, including unicode and a 200-char key;
  `last4` equals the final 4 chars; two encryptions of the same key differ in `ciphertext`, `iv`,
  and `salt`; flipping a byte of `ciphertext` → `VaultDecryptError`; flipping a byte of `tag` →
  `VaultDecryptError`; a different master key → `VaultDecryptError`; the thrown message contains
  neither plaintext nor ciphertext hex; `resolveMasterKey({NODE_ENV:"production"})` throws;
  with the var set, returns it; dev fallback returns the constant.
- **Commits:** (1) `master-key.ts` + test; (2) `vault.ts` + test; (3) boot guard with an
  actionable exit message; (4) `.env.example`, `render.yaml`, README env table.

### Phase 3 — `provider.ts` + taxonomy + `http.ts` + `registry.ts` + `fake.ts`

- **Files:** `server/src/ai/provider.ts`, `http.ts` + test, `providers/registry.ts`,
  `providers/fake.ts` (N)
- **Depends on:** —
- **Acceptance:** Types compile. `fakeProvider()` satisfies `AiProvider`. `getProvider` throws a
  clear "not implemented yet" until phase 4.
- **Tests assert:** `AI_ERROR_STATUS` maps all six codes to 428/401/402/429/502/502 and has
  exactly six entries; `KEY_SHAPE` accepts a realistic sample per provider and rejects empty /
  whitespace / 600-char / wrong-prefix; `fetchJson` aborts at the timeout → `provider_error`;
  a non-JSON 500 body → `provider_error` without a parse throw;
  `scrubKey("bad key sk-ant-abc", "sk-ant-abc")` contains no `sk-ant-abc`;
  `fakeProvider({validate:"invalid_key"})` resolves `{ok:false, code:"invalid_key"}` and
  increments `script.calls.validate`; `overrideProvider`/`resetProviders` round-trip.
- **Commits:** (1) types + taxonomy + shapes; (2) `http.ts` + `scrubKey` + test;
  (3) `registry.ts`; (4) `fake.ts`.

### Phase 4 — Anthropic adapter

- **Files:** `providers/anthropic.ts` + test + `__fixtures__/anthropic.ts` (N);
  `registry.ts` (M)
- **Depends on:** 3
- **Tests assert:** 200 validate → `{ok:true, model}` and the request carried `x-api-key`,
  `anthropic-version`, `max_tokens: 1`; 401 `authentication_error` → `invalid_key`; 400 "credit
  balance is too low" → `insufficient_credit`; 429 with `retry-after: 30` → `rate_limited` with
  `retryAfter === 30`; 529 → `provider_error`; `fetch` rejecting → `provider_error`;
  `complete()` sends a single tool with `tool_choice`, returns the parsed `input` as `data`, and
  maps `usage.input_tokens`/`output_tokens`; no thrown error's message contains the api key.
- **Commits:** (1) fixtures; (2) `validate()` + tests; (3) `complete()` + tests; (4) registry wiring.

### Phase 5 — Gemini adapter

- **Files:** `providers/gemini.ts` + test + `__fixtures__/gemini.ts` (N); `registry.ts` (M)
- **Depends on:** 3
- **Tests assert:** validate issues `GET /v1beta/models/{model}`; 400 `API_KEY_INVALID` →
  `invalid_key`; 403 `PERMISSION_DENIED` → `invalid_key`; 403 with billing detail →
  `insufficient_credit`; 429 `RESOURCE_EXHAUSTED` → `rate_limited`; 503 → `provider_error`;
  `complete()` sets `responseMimeType` + `responseSchema`, parses
  `candidates[0].content.parts[0].text`, maps `usageMetadata`; malformed JSON → `bad_output`;
  key never in an error message; **the key goes in the `x-goog-api-key` header, never the query
  string** (query strings land in access logs).
- **Commits:** (1) fixtures; (2) `validate()`; (3) `complete()`; (4) registry wiring.

### Phase 6 — OpenAI adapter

- **Files:** `providers/openai.ts` + test + `__fixtures__/openai.ts` (N); `registry.ts` (M)
- **Depends on:** 3
- **Tests assert:** validate issues `GET /v1/models` with `Authorization: Bearer`; 401 →
  `invalid_key`; 429 `insufficient_quota` → `insufficient_credit`; plain 429 → `rate_limited`
  with `retryAfter` when the header is present; 500 → `provider_error`; `complete()` sends
  `response_format.json_schema` with `strict: true`, parses `choices[0].message.content`, maps
  `usage.prompt_tokens`/`completion_tokens`; a `refusal` → `bad_output`; key never in an error.
- **Commits:** (1) fixtures; (2) `validate()`; (3) `complete()`; (4) registry wiring.

### Phase 7 — `keys.ts` repository + `POST/GET/DELETE /api/ai/keys`

- **Files:** `server/src/ai/keys.ts` + test, `server/src/routes/ai-keys.ts` + test (N);
  `server/src/app.ts` (M)
- **Depends on:** 1, 2, 3
- **Acceptance:** All three endpoints work end to end against real SQLite with
  `overrideProvider(..., fakeProvider())`. **The leak test passes.**
- **Tests assert:**
  - `201` on save; body is exactly `{ key: {provider, last4, model, validatedAt, preferred, createdAt} }` — assert the key set, not just presence.
  - Saving twice upserts: `GET` returns one row with the second key's `last4`.
  - `400` for provider `"grok"`, empty `apiKey`, a 600-char key, a wrong-prefix key, a bad `model`.
  - `401 {code:"invalid_key"}` when the fake rejects; `402`; `429` with `retryAfter`; `502`.
  - `401` on all three routes with no bearer token.
  - `GET` returns `{keys: []}` with `200` for a fresh user.
  - `DELETE` → `204`, again → `404`; `DELETE /api/ai/keys/grok` → `400`.
  - Alice's key invisible to Bob; Bob's `DELETE` of Alice's provider → `404`.
  - **Leak test:** save `sk-ant-supersecret-plaintext-value`; then `GET /api/ai/keys`,
    `GET /api/ai/usage`, `POST` again, `DELETE` — `JSON.stringify(res.body)` contains the
    plaintext in none; the stored `ciphertext` Buffer does not contain the plaintext bytes;
    spying `console.log`/`warn`/`error` across the save, no argument stringifies to anything
    containing the plaintext.
- **Commits:** (1) `keys.ts` repo + test; (2) `POST` + validation + tests; (3) `GET` + `DELETE`
  + tests; (4) leak test + `app.ts` registration; (5) save rate limiter + test.

### Phase 8 — `requireAiKey` middleware

- **Files:** `server/src/ai/require-key.ts` + test (N)
- **Depends on:** 7
- **Acceptance:** Attaches `req.aiKey` or 428s. Nothing in F0 mounts it — it exists for F1–F4.
- **Tests assert:** against a throwaway Express app — no key → `428 {code:"no_key"}`; no token →
  `401`; with a saved key, `next()` runs and `req.aiKey` carries the correct decrypted plaintext;
  with two keys the `preferred` one wins; with none preferred the more recently validated wins;
  `prefer` forces a provider; a corrupted ciphertext row → `428`, not a 500, with no ciphertext
  in the body.
- **Commits:** (1) middleware; (2) selection-order tests; (3) decrypt-failure degradation test.

### Phase 9 — `cache.ts` + `usage.ts`

- **Files:** `server/src/ai/cache.ts` + test, `server/src/ai/usage.ts` + test (N)
- **Depends on:** 1
- **Tests assert:** `cacheKey` deterministic; key-order in `params` does not change the hash;
  changing `model` or `feature` does; **two different `userId`s with the same `params` yield an
  identical hash** (the anti-leak invariant); `getCached` → `null` on miss, parsed object on hit,
  `null` past TTL (insert with an explicit old `created_at`); `putCached` twice overwrites;
  `recordUsage` + `usageByFeature` aggregate correctly across 3 features; a cached row adds to
  `calls` and `cachedCalls` but 0 tokens; another user's rows excluded.
- **Commits:** (1) `cache.ts` + test; (2) `usage.ts` + test; (3) TTL + aggregation edge tests.

### Phase 10 — `GET /api/ai/usage`

- **Files:** `server/src/routes/ai-usage.ts` + test (N); `server/src/app.ts` (M)
- **Depends on:** 9
- **Tests assert:** `401` unauthenticated; `200 {usage: []}` for a fresh user; after seeding via
  `recordUsage`, the response matches the expected aggregate exactly and is sorted by `feature`;
  another user's usage never appears.
- **Commits:** (1) router + registration; (2) tests; (3) cross-user isolation test.

### Phase 11 — `web/src/lib/ai.ts` typed client

- **Files:** `web/src/lib/ai.ts` (N)
- **Depends on:** 7, 10
- **Acceptance:** `npm run typecheck --workspace=web` green. Exports `ProviderId`,
  `RedactedKey`, `UsageRow`, `AiErrorCode`, `listKeys`, `saveKey`, `deleteKey`, `fetchUsage`,
  and an `AiClientError` carrying `{status, code, retryAfter, message}`.
- **Critical detail:** `saveKey` must **not** route its 401 through `authFetch` — `auth.tsx`
  logs the user out on any 401 and a provider-rejected key returns 401. `saveKey` takes the raw
  token and does its own `fetch`. The other three use `authFetch` normally.
- **Verification:** typecheck + build; manual check that pasting a bad key does not sign you out.
- **Commits:** (1) types; (2) read functions on `authFetch`; (3) `saveKey` with its own
  401-safe path.

### Phase 12 — Profile "AI & Keys" section

- **Files:** `web/src/components/Ai/{KeysSection,KeyRow,AddKeyForm,UsageSummary}.tsx`,
  `index.ts` (N); `web/src/pages/ProfilePage.tsx` (M)
- **Depends on:** 11
- **Acceptance:** One row per provider showing state / `last4` / model / last-validated. Add
  form is `type="password"`, paste-friendly, inline "✓ Connected — Claude Sonnet 5" /
  "✗ That key was rejected". Delete confirms. Plain-language storage disclosure visible without
  expanding anything. Usage table shows cached calls in their own column. Follows the existing
  Tailwind vocabulary (`bg-raise`, `ring-1 ring-white/5`, `font-display`, `text-muted`,
  `rounded-card`).
- **Verification:** typecheck + build; each taxonomy code renders its own message (402 → "out of
  credit", 429 → "rate limited, retry in Ns", 502 → "couldn't reach the provider").
- **Commits:** (1) `KeyRow` + `KeysSection` read-only list; (2) `AddKeyForm` + error rendering;
  (3) delete-with-confirm; (4) `UsageSummary`; (5) `ProfilePage` wiring + `id="ai-keys"` anchor.

### Phase 13 — Shared `<KeyPrompt />`

- **Files:** `web/src/components/Ai/KeyPrompt.tsx` (N); `web/src/components/Ai/index.ts` (M)
- **Depends on:** 12
- **Acceptance:** Props `{ feature: string; blurb: string }`; renders the feature's value
  proposition and a link to `/profile#ai-keys`. Exported from the barrel. Not rendered anywhere
  in F0.
- **Commits:** (1) component; (2) barrel export.

### Phase 14 — Docs: README + threat model

- **Files:** `README.md` (M), `docs/THREAT-MODEL.md` (N)
- **Depends on:** 1–13
- **Acceptance:** README gains the `/api/ai/*` rows, a BYOK feature bullet, and a fix to the
  "No database" line in Stack, which is now false. `docs/THREAT-MODEL.md` states what is stored,
  what an attacker with only the DB file gets (nothing usable), what an attacker with DB + env
  gets (all keys — the accepted cost), why Model A beat browser-direct and session-proxy, and
  the out-of-scope list.
- **Commits:** (1) README; (2) `docs/THREAT-MODEL.md`; (3) cross-links from the PRD and spec.

## 10. Out of scope

- Any F1–F4 feature route, prompt file, or AI-rendering UI. `cache.ts` and `require-key.ts` ship
  unused by design.
- Key rotation, bulk re-encryption after a master-key change, expiry tracking.
- Team/shared keys, Northstar-supplied keys, trials, billing, quotas.
- Local model adapters (Ollama, LM Studio) — the interface does not preclude them.
- Streaming responses; conversational chat UI.
- Enabling `PRAGMA foreign_keys` or cascade deletes.
- A web test runner / component tests.
- Envelope encryption, KMS, HSM, decrypt audit logging.
- Distributed rate limiting.
- Cache eviction job — TTL is enforced on read only; `idx_ai_cache_created` makes a future job cheap.
