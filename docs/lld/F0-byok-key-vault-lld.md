# LLD F0 — BYOK Key Vault & Provider Abstraction

| | |
| --- | --- |
| **Status** | Ready to implement |
| **Branch** | `feat/f0-byok-key-vault` |
| **PRD** | `docs/prds/F0-byok-key-vault.md` |
| **Cluster spec** | `docs/superpowers/specs/2026-08-14-byok-ai-planning-cluster-design.md` |
| **Blocks** | F1, F2, F3, F4 |
| **New runtime deps** | **none** — `node:crypto` only |

## 0. Ground rules for this feature

This is a real running codebase, not a whiteboard exercise.

- **Persistence is the real SQLite database.** Every table lives in the existing
  `db.exec()` block in `server/src/db.ts` (better-sqlite3, WAL, file-backed —
  `:memory:` only because `NODE_ENV === "test"` already selects it). No repository
  abstraction is introduced; the house style is prepared statements inline in the
  route, and F0 follows it.
- **The Express app is the real app.** `server/src/app.ts` gains one more
  `app.use(aiKeysRouter)` line, mounted exactly like `tripsRouter`.
- **The only fake in this design is the outbound provider HTTP layer.**
  `AiProvider` has four implementations: three that make real `fetch` calls to
  Anthropic / Google / OpenAI, and `fake.ts`, which is what the test suite and
  CI use. Nothing else is mocked. There is no mock database, no mock cache, no
  seeded fixture users.
- **No network in tests, ever.** Adapter tests drive the pure response-mapping
  functions with recorded JSON fixtures. Route tests force the registry to
  `fake.ts`. `global.fetch` is additionally stubbed to throw in a setup file, so
  an accidental live call fails loudly rather than silently hitting the internet.

---

## 1. Modules affected

### `server/`

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `src/db.ts` | **Mod** | Append `ai_keys`, `ai_cache`, `ai_usage`, `ai_prefs` DDL + indexes to the single existing `db.exec()` block. |
| `src/ai/vault.ts` | **New** | AES-256-GCM seal/open of an API key; scrypt derivation; master-key resolution and boot guard. |
| `src/ai/vault.test.ts` | **New** | Round-trip, tamper, wrong-master-key, salt-uniqueness, `last4` tests. |
| `src/ai/provider.ts` | **New** | `AiProvider` interface, `CompletionRequest`/`CompletionResult`/`ValidationResult`, `AiError` taxonomy, `sendAiError`. |
| `src/ai/provider.test.ts` | **New** | Error-code → HTTP-status mapping, `AiError.toJSON()` shape, `retryAfter` passthrough. |
| `src/ai/http.ts` | **New** | Tiny `fetch` wrapper: JSON in/out, per-call timeout via `AbortSignal.timeout`, network failure → `provider_error`. Never logs headers. |
| `src/ai/registry.ts` | **New** | `getProvider(id)`; returns `fake.ts` for all three ids when `NOMAD_AI_FAKE=1`. The only place routes learn about a concrete vendor. |
| `src/ai/providers/fake.ts` | **New** | Scriptable, deterministic, network-free `AiProvider` used by every route test. |
| `src/ai/providers/anthropic.ts` | **New** | Messages API adapter; tool-use structured output; Anthropic error mapping. |
| `src/ai/providers/gemini.ts` | **New** | Generative Language API adapter; `responseSchema` structured output; Google error mapping. |
| `src/ai/providers/openai.ts` | **New** | Chat Completions adapter; `response_format: json_schema` strict mode; OpenAI error mapping. |
| `src/ai/providers/*.test.ts` | **New** | One test file per adapter, driven purely by fixtures. |
| `src/ai/providers/__fixtures__/*.json` | **New** | Recorded success + error bodies per vendor. |
| `src/ai/keystore.ts` | **New** | The only module that reads/writes `ai_keys` and `ai_prefs`: `saveKey`, `listKeys`, `deleteKey`, `selectKey`, `setPreferred`. |
| `src/ai/loadUserKey.ts` | **New** | Express middleware: selects a provider, decrypts, attaches `req.ai`. Emits `no_key` (428). |
| `src/ai/cache.ts` | **New** | `cacheKey()` hashing + `getCached`/`putCached` against real `ai_cache`. Consumed by F1–F4. |
| `src/ai/cache.test.ts` | **New** | Determinism, key-order insensitivity, "no user id in key" assertion, hit/miss. |
| `src/ai/usage.ts` | **New** | `recordUsage()` insert + `usageSummary()` aggregate over real `ai_usage`. |
| `src/ai/usage.test.ts` | **New** | Grouping, cached-vs-billed split, per-user isolation. |
| `src/routes/ai-keys.ts` | **New** | `POST/GET/DELETE /api/ai/keys`, `PUT /api/ai/keys/preferred`, `GET /api/ai/usage`. |
| `src/routes/ai-keys.test.ts` | **New** | Route contracts, cross-user isolation, and the **leak test**. |
| `src/routes/ai-boot.test.ts` | **New** | `spawnSync` boot test: production without `NOMAD_MASTER_KEY` exits non-zero. |
| `src/app.ts` | **Mod** | `import { aiKeysRouter }` + `app.use(aiKeysRouter)`. |
| `src/index.ts` | **Mod** | Call `assertVaultConfigured()` before `createApp()`. |
| `src/test-setup.ts` | **New** | Sets `NOMAD_AI_FAKE=1`, stubs `global.fetch` to throw "no network in tests". |
| `vitest.config.ts` | **New** | Registers `setupFiles: ["src/test-setup.ts"]`. (Repo currently has no vitest config; defaults are otherwise fine.) |

### `web/`

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `src/lib/ai.ts` | **New** | Typed client for `/api/ai/*`; shared request/response types mirroring the server. |
| `src/lib/auth.tsx` | **Mod** | `authFetch` gains `opts?: { signOutOn401?: boolean }`. **Required** — see §6.6. |
| `src/components/Ai/AiKeysSection.tsx` | **New** | The whole "AI & Keys" block: three provider rows + vault note + usage. |
| `src/components/Ai/ProviderKeyRow.tsx` | **New** | One provider's row and its four-state machine. |
| `src/components/Ai/AddKeyForm.tsx` | **New** | Password input + model field + Save, with inline validation feedback. |
| `src/components/Ai/ProviderMark.tsx` | **New** | Gradient logo chip per provider (no images — matches `heroGradient` convention). |
| `src/components/Ai/UsageSummary.tsx` | **New** | Per-feature calls/tokens table with cached calls shown separately. |
| `src/components/Ai/VaultNote.tsx` | **New** | Plain-language "where your key lives" disclosure. |
| `src/components/Ai/KeyPrompt.tsx` | **New** | Shared empty state F1–F4 render when the user has no key. |
| `src/pages/ProfilePage.tsx` | **Mod** | Render `<AiKeysSection />` between the header card and "Upcoming trips". |

### `docs/`

| File | New/Mod | Responsibility |
| --- | --- | --- |
| `README.md` | **Mod** | Env-var table (`NOMAD_MASTER_KEY`, `NOMAD_DB`, `JWT_SECRET`, `NOMAD_AI_FAKE`); API table gains the four AI routes; stack line "No database" corrected. |
| `docs/THREAT-MODEL.md` | **New** | What an attacker with DB-file access gets, what they need additionally, and the residual risk we accepted. |

---

## 2. Data model

### 2.1 DDL — appended verbatim to the existing `db.exec()` in `server/src/db.ts`

The file has exactly one `db.exec()` template literal containing `users`, `trips`,
and `idx_trips_user`. Append the following inside that same template literal, after
`idx_trips_user`. Every statement is `IF NOT EXISTS`, so an existing `data.sqlite`
picks the tables up on the next boot with no migration tooling.

```sql
  CREATE TABLE IF NOT EXISTS ai_keys (
    user_id      INTEGER NOT NULL REFERENCES users(id),
    provider     TEXT    NOT NULL
      CHECK (provider IN ('anthropic', 'gemini', 'openai')),
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

  CREATE TABLE IF NOT EXISTS ai_prefs (
    user_id  INTEGER NOT NULL PRIMARY KEY REFERENCES users(id),
    provider TEXT    NOT NULL
      CHECK (provider IN ('anthropic', 'gemini', 'openai'))
  );

  CREATE TABLE IF NOT EXISTS ai_cache (
    cache_key  TEXT PRIMARY KEY,
    feature    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_cache_feature
    ON ai_cache(feature, created_at);

  CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    feature       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cached        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_usage_user
    ON ai_usage(user_id, feature);
```

### 2.2 Notes on the schema

- **Composite primary key `(user_id, provider)`** is the upsert target. It makes
  "one key per provider per user" a database invariant rather than an application
  convention, and gives `INSERT ... ON CONFLICT(user_id, provider) DO UPDATE` a
  conflict target. SQLite materialises the PK as an index prefixed by `user_id`,
  so **no separate `idx_ai_keys_user` is needed** — `WHERE user_id = ?` already
  uses it. Adding one would be dead weight.
- **`CHECK (provider IN (...))`** mirrors the `trips.status` CHECK already in the
  file. It is a second line of defence behind route validation.
- **Four BLOB columns, never one concatenated blob.** `ciphertext`, `iv`, `tag`,
  `salt` stay separate so the format is inspectable and a future rotation can
  re-derive without parsing a packed layout. better-sqlite3 binds `Buffer` → BLOB
  and returns `Buffer` on read with no conversion code.
- **`ai_prefs` is a separate table, not a column on `users` or `ai_keys`.** The
  codebase has no migration runner — only idempotent `CREATE TABLE IF NOT EXISTS`.
  Adding a column to an existing table would need `ALTER TABLE` with
  error-swallowing, which is worse. A one-row-per-user side table is additive,
  idempotent, and keeps the `ai_keys` DDL byte-identical to the cluster spec.
- **`ai_cache` is global, not per-user, and has no `user_id` column at all.** This
  is a deliberate structural guarantee behind cluster principle 5: there is no
  column into which one user's data could leak. Enforced by a test (§9.5).
- **`idx_ai_usage_user(user_id, feature)`** serves the only query `usage.ts` runs:
  `GROUP BY feature WHERE user_id = ?`.
- **`idx_ai_cache_feature(feature, created_at)`** serves future age-based eviction
  and per-feature cache inspection. Cheap now, awkward to add later.
- **No `ON DELETE CASCADE`** — matches `trips`, which also uses a bare
  `REFERENCES users(id)`. Foreign keys are not enforced by default in
  better-sqlite3 (no `PRAGMA foreign_keys = ON` in `db.ts`), so this is
  documentation of intent, consistent with what is already there. Account deletion
  is out of scope for F0.

---

## 3. Interfaces & types

### 3.1 `server/src/ai/provider.ts` — the contract F1–F4 code against

```ts
export type ProviderId = "anthropic" | "gemini" | "openai";
export const PROVIDER_IDS = ["anthropic", "gemini", "openai"] as const;

export type AiFeature = "itinerary" | "packing" | "budget" | "search";

/** JSON Schema subset every vendor can express. Deliberately narrow. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
}

export type JsonSchemaNode =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaNode; minItems?: number; maxItems?: number }
  | JsonSchemaObject;

export interface CompletionRequest<T> {
  /** Plaintext key. Lives only for the duration of the call. Never logged. */
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** Vendor-agnostic schema; each adapter translates it. */
  schema: JsonSchemaObject;
  /** Name the vendor attaches to the schema/tool. `[a-z0-9_]{1,40}`. */
  schemaName: string;
  /**
   * Runtime validator. Throws to signal a schema violation.
   * This is what makes `T` inferable — no zod, no new dependency — and it is
   * what the adapter re-runs after its single retry before giving up with
   * `bad_output`.
   */
  parse: (value: unknown) => T;
  maxTokens?: number;      // default 4096
  temperature?: number;    // default 0.4; omitted for models that reject it
  timeoutMs?: number;      // default 45_000
}

export interface CompletionResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the adapter needed its one retry to get valid JSON. */
  retried: boolean;
}

export type ValidationResult =
  | { ok: true; model: string; detail?: string }
  | { ok: false; code: AiErrorCode; message: string; retryAfter?: number };

export interface AiProvider {
  readonly id: ProviderId;
  readonly defaultModel: string;
  /** Cheapest possible call that proves the key works. */
  validate(apiKey: string, model?: string): Promise<ValidationResult>;
  /** Single-turn structured generation against a JSON schema. */
  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;
}
```

Note on generics: `T` is inferred from `parse`, so a caller writes
`complete({ ..., parse: parseItinerary })` and gets `CompletionResult<Itinerary>`
with zero annotations and zero casts. The adapter never sees `T` — it hands
`unknown` to `parse` and lets inference do the rest.

### 3.2 Error taxonomy

```ts
export type AiErrorCode =
  | "no_key"
  | "invalid_key"
  | "insufficient_credit"
  | "rate_limited"
  | "provider_error"
  | "bad_output";

export const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  no_key: 428,
  invalid_key: 401,
  insufficient_credit: 402,
  rate_limited: 429,
  provider_error: 502,
  bad_output: 502,
};

export interface AiErrorBody {
  error: string;          // human-facing, safe to render verbatim
  code: AiErrorCode;
  provider?: ProviderId;
  retryAfter?: number;    // seconds; only for rate_limited
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  readonly provider?: ProviderId;
  readonly retryAfter?: number;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { provider?: ProviderId; retryAfter?: number; cause?: unknown } = {},
  );

  /** Exactly what goes on the wire. Never includes `cause` or a stack. */
  toJSON(): AiErrorBody;

  static from(err: unknown): AiError; // non-AiError → provider_error, message scrubbed
}

/** The single place any AI route writes an error response. */
export function sendAiError(res: Response, err: unknown): void;
```

`sendAiError` sets `Retry-After` as a real header when `retryAfter` is present,
and writes `err.toJSON()` as the body. It never serialises `cause`.

### 3.3 `server/src/ai/vault.ts`

```ts
export interface SealedKey {
  ciphertext: Buffer;  // variable length == plaintext length
  iv: Buffer;          // 12 bytes
  tag: Buffer;         // 16 bytes
  salt: Buffer;        // 16 bytes
  last4: string;       // 4 chars, plaintext tail — the only plaintext we persist
}

export class VaultError extends Error {
  readonly reason: "auth_tag" | "malformed" | "master_key_missing";
}

/** Encrypts one API key under a fresh random salt + iv. */
export function encryptApiKey(plaintext: string): SealedKey;

/** Decrypts. Throws VaultError("auth_tag") on tamper or wrong master key. */
export function decryptApiKey(sealed: Omit<SealedKey, "last4">): string;

/** Resolves and memoises the master key. Throws VaultError in production. */
export function getMasterKey(): Buffer;

/** Called from index.ts before the app is built. Exits(1) in production. */
export function assertVaultConfigured(): void;

/** Pure, injectable core — this is what the unit tests drive. */
export function resolveMasterKey(env: NodeJS.ProcessEnv): Buffer;
```

### 3.4 `server/src/ai/keystore.ts`

```ts
/** The redacted shape. This is the ONLY shape that ever reaches a client. */
export interface AiKeyPublic {
  provider: ProviderId;
  last4: string;
  model: string;
  validatedAt: string | null;
  preferred: boolean;
}

export interface DecryptedKey {
  providerId: ProviderId;
  apiKey: string;   // plaintext, request-scoped only
  model: string;
}

export function saveKey(args: {
  userId: number;
  provider: ProviderId;
  apiKey: string;
  model: string;
  validatedAt: string;
  preferred: boolean;
}): AiKeyPublic;

export function listKeys(userId: number): AiKeyPublic[];

/** false when nothing was configured for that provider (→ 404). */
export function deleteKey(userId: number, provider: ProviderId): boolean;

export function setPreferred(userId: number, provider: ProviderId): boolean;

/**
 * Selection rule, in order: explicit `prefer` → ai_prefs → most recently
 * validated. Returns null when the user has no keys at all.
 * Throws AiError("provider_error") if the stored blob will not decrypt.
 */
export function selectKey(userId: number, prefer?: ProviderId): DecryptedKey | null;
```

`listKeys` uses an explicit column list — **never `SELECT *` against `ai_keys`.**
That single rule is what keeps the blobs structurally unable to reach a response.

### 3.5 `server/src/ai/cache.ts`

```ts
export interface CacheKeyInput {
  feature: AiFeature;
  destinationId?: string;
  start?: string;
  end?: string;
  mode?: string;
  model: string;
  /** Anything else that changes the answer. Key order is irrelevant. */
  options?: Record<string, string | number | boolean | null>;
}

/** sha256 over canonical (key-sorted, undefined-stripped) JSON. Hex, 64 chars. */
export function cacheKey(input: CacheKeyInput): string;

export interface CacheEntry<T> {
  payload: T;
  createdAt: string;
}

export function getCached<T>(
  key: string,
  opts?: { maxAgeMs?: number },
): CacheEntry<T> | null;

export function putCached<T>(key: string, feature: AiFeature, payload: T): void;
```

`CacheKeyInput` has no `userId` field and no index signature that could smuggle
one — the type itself is the guarantee, and §9.5 asserts it at runtime too.

### 3.6 `server/src/ai/usage.ts`

```ts
export interface UsageEvent {
  userId: number;
  feature: AiFeature;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export function recordUsage(e: UsageEvent): void;

export interface UsageSummaryRow {
  feature: AiFeature;
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export function usageSummary(userId: number): UsageSummaryRow[];

export interface UsageTotals {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}
```

`usageSummary` SQL:

```sql
SELECT feature,
       COUNT(*)                              AS calls,
       SUM(cached)                           AS cachedCalls,
       COALESCE(SUM(input_tokens),  0)       AS inputTokens,
       COALESCE(SUM(output_tokens), 0)       AS outputTokens
FROM ai_usage
WHERE user_id = ?
GROUP BY feature
ORDER BY feature
```

A cached hit is still a row with `cached = 1` and `input_tokens = 0` — so
`calls` counts every user-visible request and `cachedCalls` shows how many were
free. That is what makes the saving visible in the UI.

---

## 4. Crypto design

### 4.1 Parameters

| Element | Value | Why |
| --- | --- | --- |
| Cipher | `aes-256-gcm` | Authenticated encryption; tamper detection comes free. |
| Content key | 32 bytes | AES-256. |
| KDF | `crypto.scryptSync(master, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })` | Node built-in; `N=16384` is the documented default cost and lands ~60–90 ms — acceptable at one call per save and one per AI request, unacceptable to skip. `maxmem` must be raised explicitly or `N=16384, r=8` exceeds Node's 32 MB default and throws. |
| Salt | 16 bytes, `randomBytes(16)`, **fresh per save** | PRD-specified. Fresh-per-save (not fresh-per-user) means replacing a key re-derives, so an old leaked derived key is worthless. |
| IV | 12 bytes, `randomBytes(12)` | GCM's native nonce size; 12 bytes is the only length that skips GHASH-based derivation and is what the spec recommends. Never reused — new IV every `encryptApiKey` call. |
| Auth tag | 16 bytes, `cipher.getAuthTag()` | Full-length tag; no truncation. |
| AAD | `${userId}:${provider}` | Binds a blob to the row it lives in, so an attacker with database write access cannot transplant user A's `(ciphertext, iv, tag, salt)` into user B's row and drive A's key from B's session. Both halves come from the row's own primary key. Originally deferred as "future hardening"; taken before any data existed, because there is no migration tooling here and the format could never be changed for free again. |
| `last4` | `plaintext.slice(-4)` | Last 4 chars, not first — key prefixes (`sk-ant-`, `AIza`) are shared across all keys and identify nothing. |

### 4.2 Column mapping

| SQL column | Type | Source |
| --- | --- | --- |
| `ciphertext` | BLOB | `Buffer.concat([c.update(plaintext, "utf8"), c.final()])` |
| `iv` | BLOB (12) | `randomBytes(12)` |
| `tag` | BLOB (16) | `cipher.getAuthTag()` — read **after** `final()` |
| `salt` | BLOB (16) | `randomBytes(16)` |
| `last4` | TEXT (4) | `plaintext.slice(-4)` |

### 4.3 Encrypt

```
salt = randomBytes(16)
iv   = randomBytes(12)
dek  = scryptSync(getMasterKey(), salt, 32, { N:16384, r:8, p:1, maxmem:64MB })
c    = createCipheriv("aes-256-gcm", dek, iv)
ct   = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
tag  = c.getAuthTag()
→ { ciphertext: ct, iv, tag, salt, last4: plaintext.slice(-4) }
```

### 4.4 Decrypt and tag verification

```
dek = scryptSync(getMasterKey(), salt, 32, {...})
d   = createDecipheriv("aes-256-gcm", dek, iv)
d.setAuthTag(tag)                       // MUST be before final()
pt  = Buffer.concat([d.update(ciphertext), d.final()]).toString("utf8")
```

`decipher.final()` is where GCM verifies the tag. If the ciphertext was modified,
the tag was modified, or the derived key is wrong (wrong master key, wrong salt),
`final()` throws `Unsupported state or unable to authenticate data`. `vault.ts`
catches **only** at this boundary and rethrows `new VaultError("auth_tag")` —
the original message and any partially-decrypted bytes are dropped on the floor.
There is no path by which a wrong-key decryption returns garbage plaintext:
GCM either authenticates or throws.

Additional structural guard before touching the cipher: if `iv.length !== 12`,
`tag.length !== 16`, or `salt.length !== 16`, throw `VaultError("malformed")`
without calling `createDecipheriv` at all.

### 4.5 Derived-key memo (performance, optional but recommended)

scrypt at these parameters is ~60–90 ms. A user making an AI request pays it once
per request. `vault.ts` keeps a module-level `Map<string, Buffer>` keyed by
`salt.toString("hex")`, capped at 64 entries with oldest-eviction. This is an
in-process cache of *derived* keys, not of plaintext API keys — a distinction
worth keeping in review. It resets on restart and is never serialised.

### 4.6 Boot-time master-key behaviour

```ts
const DEV_MASTER_KEY = "northstar-dev-master-key-do-not-use-in-production";

export function resolveMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.NOMAD_MASTER_KEY?.trim();
  const isProd = env.NODE_ENV === "production";

  if (isProd) {
    if (!raw) throw new VaultError("master_key_missing", MISSING_MSG);
    if (raw.length < 32) throw new VaultError("master_key_missing", SHORT_MSG);
    if (raw === DEV_MASTER_KEY) throw new VaultError("master_key_missing", DEV_IN_PROD_MSG);
    return Buffer.from(raw, "utf8");
  }

  if (raw) return Buffer.from(raw, "utf8");
  warnOnce(DEV_WARNING);          // printed exactly once per process
  return Buffer.from(DEV_MASTER_KEY, "utf8");
}
```

Exact behaviours:

- **Production, key absent / shorter than 32 chars / equal to the dev key** →
  `assertVaultConfigured()` in `src/index.ts` catches the `VaultError`, writes to
  **stderr**:

  ```
  FATAL: NOMAD_MASTER_KEY is required when NODE_ENV=production.
  It encrypts every user's AI API key at rest (AES-256-GCM).
  Generate one with:  openssl rand -base64 48
  Then set it in the environment and restart. Refusing to start.
  ```

  and calls `process.exit(1)`. This happens **before** `createApp()` and before
  any `listen()`, so no port is bound and the failure is instant.

- **Non-production, key absent** → returns the fixed dev key and prints once:

  ```
  ⚠️  NOMAD_MASTER_KEY is not set — using the built-in DEVELOPMENT key.
     Stored AI keys are readable by anyone with this repo. Never ship this.
  ```

  This is what keeps `npm run dev` and `npm test` working with zero setup.

- **The 32-character minimum** exists because scrypt happily derives from a
  4-character master key and would give a false sense of security. `openssl rand
  -base64 48` produces 64 characters.

- `getMasterKey()` memoises the resolved buffer, so the warning is printed once
  and `process.env` is read once. Tests that need a *different* master key call
  the exported `resolveMasterKey(fakeEnv)` directly plus a
  `__resetMasterKeyForTests()` escape hatch — this is why the resolution logic is
  a pure function taking `env` rather than reading `process.env` inline.

---

## 5. Provider adapters

All three share `src/ai/http.ts`:

```ts
export async function requestJson(args: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}): Promise<{ status: number; headers: Headers; body: unknown }>;
```

It uses `AbortSignal.timeout(timeoutMs)` (Node 20 built-in), never throws on a
non-2xx status (the caller maps it), and converts a thrown `fetch` rejection or
`TimeoutError` into `AiError("provider_error", "could not reach <vendor>")`.
It logs nothing — not the URL, not the headers, not the body.

Each adapter is structured as **one thin I/O function plus pure mapping
functions**, because the pure functions are what the fixture tests exercise:

```ts
// per adapter
export function mapError(status: number, body: unknown, headers: Headers): AiError;
export function toVendorSchema(schema: JsonSchemaObject): unknown;
export function extractJson(body: unknown): unknown;     // throws AiError("bad_output")
export function extractUsage(body: unknown): { inputTokens: number; outputTokens: number };
```

### 5.1 Anthropic — `defaultModel: "claude-sonnet-5"`

**Common headers**

```
x-api-key: <apiKey>
anthropic-version: 2023-06-01
content-type: application/json
```

**`validate()`** — cheapest real call: a 1-token message.

```
POST https://api.anthropic.com/v1/messages          timeout 8_000 ms
{ "model": "<model>", "max_tokens": 1,
  "messages": [{ "role": "user", "content": "hi" }] }
```

200 (including `stop_reason: "max_tokens"`) → `{ ok: true, model }`. Anthropic
offers no free credential-check endpoint, so this is the floor: one input token,
one output token.

**`complete<T>()`** — forced tool use is Anthropic's structured-output mechanism.

```
POST https://api.anthropic.com/v1/messages          timeout = req.timeoutMs
{
  "model": "<model>",
  "max_tokens": <maxTokens ?? 4096>,
  "temperature": <temperature ?? 0.4>,
  "system": "<system>",
  "messages": [{ "role": "user", "content": "<user>" }],
  "tools": [{
    "name": "<schemaName>",
    "description": "Return the result using this schema.",
    "input_schema": <schema verbatim>
  }],
  "tool_choice": { "type": "tool", "name": "<schemaName>" }
}
```

`toVendorSchema` is the **identity function** here — Anthropic's `input_schema`
takes plain JSON Schema, so the internal shape passes straight through.

`extractJson`: find the first `content[]` block with `type === "tool_use"` and
whose `name === schemaName`; return its `.input` (already a parsed object, not a
string). If no such block exists → `AiError("bad_output")`.

`extractUsage`: `usage.input_tokens` / `usage.output_tokens`.

**Error mapping**

| Upstream | Condition | Internal |
| --- | --- | --- |
| 401 | `error.type === "authentication_error"` | `invalid_key` |
| 403 | `error.type === "permission_error"` | `invalid_key` |
| 400 | message matches `/credit balance is too low/i` | `insufficient_credit` |
| 400 | anything else | `provider_error` |
| 404 | unknown model id | `provider_error` ("model \<x\> is not available on your account") |
| 429 | — | `rate_limited`, `retryAfter` from the `retry-after` header, else 30 |
| 500/503 | — | `provider_error` |
| 529 | `overloaded_error` | `provider_error`, `retryAfter: 30` |
| network / timeout | — | `provider_error` |

### 5.2 Gemini — `defaultModel: "gemini-2.5-pro"`

**Common headers** — the key goes in a **header, never a query string**, so it
cannot land in an access log, a proxy log, or a `Referer`:

```
x-goog-api-key: <apiKey>
content-type: application/json
```

**`validate()`** — `models.get`, which costs zero tokens.

```
GET https://generativelanguage.googleapis.com/v1beta/models/<model>   timeout 8_000 ms
```

200 → `{ ok: true, model }`. This is strictly cheaper than Anthropic's — no
generation happens at all.

**`complete<T>()`**

```
POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
{
  "systemInstruction": { "parts": [{ "text": "<system>" }] },
  "contents": [{ "role": "user", "parts": [{ "text": "<user>" }] }],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": <toVendorSchema(schema)>,
    "temperature": <temperature ?? 0.4>,
    "maxOutputTokens": <maxTokens ?? 4096>
  }
}
```

`toVendorSchema` — Gemini's `responseSchema` is an OpenAPI-3.0 subset, not full
JSON Schema. The transform, applied recursively:

- **drop** `additionalProperties`, `$schema`, `title`, `default`, `minItems`,
  `maxItems`, `minimum`, `maximum` (unsupported keywords cause a 400)
- **keep** `type`, `properties`, `items`, `required`, `enum`, `description`
- `enum` is only legal alongside `type: "string"` — assert this
- emit `propertyOrdering: Object.keys(properties)` to stabilise field order,
  which measurably improves output quality on nested objects

`extractJson`: `candidates[0].content.parts[0].text` is a **JSON string**, so
`JSON.parse` it (unlike Anthropic, where it arrives pre-parsed). If
`candidates[0].finishReason` is `"SAFETY"`, `"RECITATION"`, or `"MAX_TOKENS"` →
`AiError("bad_output")` with that reason named in the message.

`extractUsage`: `usageMetadata.promptTokenCount` / `usageMetadata.candidatesTokenCount`.

**Error mapping**

| Upstream | Condition | Internal |
| --- | --- | --- |
| 400 | `error.status === "INVALID_ARGUMENT"` && `/API key not valid/i` | `invalid_key` |
| 400 | `error.status === "INVALID_ARGUMENT"` (other) | `provider_error` (usually our schema) |
| 401/403 | `PERMISSION_DENIED` / `UNAUTHENTICATED` | `invalid_key` |
| 429 | `RESOURCE_EXHAUSTED` && `/billing|free tier/i` | `insufficient_credit` |
| 429 | otherwise | `rate_limited`; `retryAfter` parsed from `error.details[].retryDelay` (`"27s"` → `27`), else `retry-after` header, else 30 |
| 404 | model not found | `provider_error` |
| 500/503 | `INTERNAL` / `UNAVAILABLE` | `provider_error` |
| network / timeout | — | `provider_error` |

### 5.3 OpenAI — `defaultModel: "gpt-5"`

**Common headers**

```
authorization: Bearer <apiKey>
content-type: application/json
```

**`validate()`** — cheapest possible: a free list call, zero tokens.

```
GET https://api.openai.com/v1/models                timeout 8_000 ms
```

200 → `{ ok: true, model }`.

**`complete<T>()`**

```
POST https://api.openai.com/v1/chat/completions
{
  "model": "<model>",
  "messages": [
    { "role": "system", "content": "<system>" },
    { "role": "user",   "content": "<user>" }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "<schemaName>",
      "strict": true,
      "schema": <toVendorSchema(schema)>
    }
  },
  "max_completion_tokens": <maxTokens ?? 4096>
}
```

Two model-family quirks the adapter handles explicitly:

- `max_completion_tokens`, not `max_tokens` — the latter is rejected by `gpt-5`.
- `temperature` is **omitted entirely** when the model id matches `/^(gpt-5|o\d)/`,
  because those models accept only the default and 400 otherwise. For other
  models it is sent normally.

`toVendorSchema` — strict mode has hard requirements, applied recursively to
every object node:

- set `additionalProperties: false` on every object
- set `required` to **all** property keys (strict mode forbids optional fields;
  a genuinely optional field must be typed as a union with `null` in the schema)
- drop `minimum`/`maximum`/`minItems`/`maxItems` (unsupported under `strict`)

`extractJson`: if `choices[0].message.refusal` is non-null →
`AiError("bad_output", "the model refused: <refusal>")`. Otherwise
`JSON.parse(choices[0].message.content)`. If `finish_reason === "length"` →
`AiError("bad_output", "response was truncated")`.

`extractUsage`: `usage.prompt_tokens` / `usage.completion_tokens`.

**Error mapping**

| Upstream | Condition | Internal |
| --- | --- | --- |
| 401 | `error.code === "invalid_api_key"` | `invalid_key` |
| 403 | `error.code === "unsupported_country_region_territory"` | `provider_error` |
| 404 | `error.code === "model_not_found"` | `provider_error` ("your account has no access to \<model\>") |
| 429 | `error.code === "insufficient_quota"` | `insufficient_credit` |
| 429 | otherwise | `rate_limited`; `retryAfter` from `retry-after` header, else 20 |
| 400 | `context_length_exceeded` | `provider_error` |
| 400 | `invalid_request_error` about `response_format` | `provider_error` (our bug — message says so) |
| 500/503 | — | `provider_error` |
| network / timeout | — | `provider_error` |

### 5.4 `fake.ts` — the test double, and the only fake in the system

```ts
export interface FakeScript {
  /** Default: { ok: true, model: "fake-model-1" } */
  validate?: ValidationResult | AiError;
  /** Consumed in order; falls back to `defaultPayload` when exhausted. */
  completions?: Array<unknown | AiError>;
  defaultPayload?: unknown;
  /** Simulated latency in ms. Default 0. */
  latencyMs?: number;
}

export interface FakeCall {
  kind: "validate" | "complete";
  apiKey: string;
  model: string;
  system?: string;
  user?: string;
  schemaName?: string;
}

export interface FakeProvider extends AiProvider {
  readonly calls: FakeCall[];
  script(next: FakeScript): void;
  reset(): void;
}

export function createFakeProvider(
  id: ProviderId,
  script?: FakeScript,
): FakeProvider;
```

Behaviour:

- **Never calls `fetch`.** Not stubbed-out `fetch` — it does not reference it.
- `validate()` resolves the scripted result; if the script holds an `AiError`, it
  rejects with it, which is how the "provider rejected the key" route test
  produces a `401 invalid_key` with no network.
- `complete()` shifts the next scripted item; if it is an `AiError`, it rejects;
  otherwise it runs `req.parse(item)` so the fake exercises the same validation
  path as a real adapter, and returns deterministic token counts:
  `inputTokens = ceil((system.length + user.length) / 4)`,
  `outputTokens = ceil(JSON.stringify(payload).length / 4)`. Deterministic counts
  mean the usage tests can assert exact numbers.
- Records every call in `calls`, including the `apiKey` it received — that is how
  the `loadUserKey` tests prove the *decrypted* key reached the provider without
  ever asserting on a response body.

### 5.5 `registry.ts`

```ts
export function getProvider(id: ProviderId): AiProvider;
export function useFakeProviders(script?: FakeScript): Record<ProviderId, FakeProvider>;
export function resetProviders(): void;
```

- Module-level `Record<ProviderId, AiProvider>` holding the three real adapters.
- If `process.env.NOMAD_AI_FAKE === "1"`, all three entries are `FakeProvider`
  instances at module init. `src/test-setup.ts` sets that env var, so **the entire
  route test suite is network-free by construction**, not by remembering to stub.
- `useFakeProviders()` lets an individual test swap in a freshly scripted fake and
  keep a handle on it; `resetProviders()` restores in `afterEach`.
- **Routes import `getProvider`, never a concrete adapter.** This is the seam that
  makes the PRD's "F1 can be built touching zero provider-specific code" true.

---

## 6. Route contracts

All routes are mounted from `src/routes/ai-keys.ts` and follow the `trips.ts`
pattern exactly: `router.use("/api/ai", requireAuth)` at the top, then handlers
that scope every statement by `req.userId`.

### 6.0 Shared types (mirrored verbatim in `web/src/lib/ai.ts`)

```ts
export type ProviderId = "anthropic" | "gemini" | "openai";

export interface AiKeyPublic {
  provider: ProviderId;
  last4: string;
  model: string;
  validatedAt: string | null;
  preferred: boolean;
}

export interface ErrorBody {
  error: string;
  code:
    | "unauthenticated" | "bad_request" | "not_found"
    | "no_key" | "invalid_key" | "insufficient_credit"
    | "rate_limited" | "provider_error" | "bad_output";
  provider?: ProviderId;
  retryAfter?: number;
}
```

### 6.1 `POST /api/ai/keys`

| | |
| --- | --- |
| **Auth** | Required (`requireAuth`) |
| **Body** | `SaveKeyRequest` |
| **Success** | `200 { key: AiKeyPublic }` |

```ts
export interface SaveKeyRequest {
  provider: ProviderId;
  apiKey: string;
  model?: string;
  preferred?: boolean;
}
export interface SaveKeyResponse { key: AiKeyPublic }
```

Flow:

1. Validate `provider ∈ PROVIDER_IDS` → else `400 bad_request`.
2. Validate `apiKey` shape against `KEY_SHAPE[provider]` → else `400 bad_request`.
   ```ts
   const KEY_SHAPE: Record<ProviderId, RegExp> = {
     anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
     openai:    /^sk-[A-Za-z0-9_-]{20,}$/,
     gemini:    /^AIza[A-Za-z0-9_-]{30,}$/,
   };
   ```
   Deliberately loose, and centralised in one constant so a vendor prefix change
   is a one-line fix. Also enforce `apiKey.length <= 500` and no internal
   whitespace (catches paste-with-newline, which is the #1 real-world failure).
3. Resolve model: `model ?? provider.defaultModel`; must match
   `/^[A-Za-z0-9._:-]{1,64}$/` → else `400 bad_request`.
4. `await getProvider(provider).validate(apiKey, model)`. On `!ok`, respond with
   `AI_ERROR_STATUS[result.code]` and the `ErrorBody`. **Nothing is written to the
   database on a failed validation.**
5. `encryptApiKey(apiKey)` → `saveKey({ ..., validatedAt: new Date().toISOString() })`,
   which upserts on `(user_id, provider)`.
6. Preference: set when `preferred === true`, **or** when this is the user's first
   key. Otherwise untouched.
7. `200 { key }`.

Errors:

| Status | `code` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | No/expired bearer token (from `requireAuth`) |
| 400 | `bad_request` | Unknown provider, malformed key shape, bad model string |
| 401 | `invalid_key` | Provider rejected the credentials |
| 402 | `insufficient_credit` | Key valid, account out of funds |
| 429 | `rate_limited` | Provider throttled the validation call; `retryAfter` present |
| 502 | `provider_error` | Provider unreachable, timed out, or 5xx |

> **The two 401s are different and the client must distinguish them by `code`.**
> `unauthenticated` means "your session is gone"; `invalid_key` means "that API
> key was rejected". Conflating them logs the user out for typing a bad key. See
> §6.6.

### 6.2 `GET /api/ai/keys`

| | |
| --- | --- |
| **Auth** | Required |
| **Success** | `200 { keys: AiKeyPublic[] }` — `[]` is valid and not an error |
| **Errors** | `401 unauthenticated` |

Ordered `ORDER BY provider`. Explicit column list. No blob column is selected.

### 6.3 `DELETE /api/ai/keys/:provider`

| | |
| --- | --- |
| **Auth** | Required |
| **Path param** | `provider: ProviderId` |
| **Success** | `204` no body |

| Status | `code` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | No token |
| 400 | `bad_request` | `:provider` not in the enum |
| 404 | `not_found` | Valid provider, but this user has nothing configured |

Deleting also removes the `ai_prefs` row when it pointed at this provider — done
inside a `db.transaction()` so a user is never left preferring a provider they no
longer have a key for. Historical `ai_usage` rows are **kept**: deleting a key
should not erase the user's spend history.

### 6.4 `GET /api/ai/usage`

| | |
| --- | --- |
| **Auth** | Required |
| **Success** | `200 { usage: UsageSummaryRow[]; totals: UsageTotals }` |
| **Errors** | `401 unauthenticated` |

```ts
export interface UsageResponse {
  usage: UsageSummaryRow[];   // [] for a user who has made no AI calls
  totals: UsageTotals;
}
```

Scoped by `user_id`. Until F1 ships this returns an empty array — correct, not
broken.

### 6.5 `PUT /api/ai/keys/preferred` (additive)

Not in the PRD's four routes, but the profile UI needs a "make this my default"
control and forcing a re-paste of the key to change a preference is a dark
pattern. Small, isolated, and droppable if rejected in review.

| | |
| --- | --- |
| **Auth** | Required |
| **Body** | `{ provider: ProviderId }` |
| **Success** | `200 { keys: AiKeyPublic[] }` (the full refreshed list) |
| **Errors** | `401 unauthenticated`, `400 bad_request`, `404 not_found` (no key for that provider) |

### 6.6 `loadUserKey` middleware contract

```ts
export interface AiRequest extends AuthedRequest {
  /** Populated by loadUserKey. Contains PLAINTEXT — never serialise this. */
  ai?: {
    providerId: ProviderId;
    provider: AiProvider;
    apiKey: string;
    model: string;
  };
}

export function loadUserKey(
  req: AiRequest,
  res: Response,
  next: NextFunction,
): void;
```

Usage in F1–F4: `router.use("/api/ai/itinerary", requireAuth, loadUserKey)`.
It **must** run after `requireAuth` — it reads `req.userId`.

**Provider-selection rule, in strict order:**

1. **Explicit preference on the request** — `req.body?.provider` or
   `req.query.provider`, validated against the enum. If present but the user has
   no key for it → `428 no_key`, message naming that provider ("you haven't added
   an OpenAI key yet"). It does *not* silently fall through to a different
   provider, because the user asked for a specific one.
2. **Stored preference** — the `ai_prefs` row, but only if a matching `ai_keys`
   row still exists (join, don't two-step).
3. **Most recently validated key:**
   ```sql
   SELECT provider, ciphertext, iv, tag, salt, model
   FROM ai_keys
   WHERE user_id = ?
   ORDER BY validated_at IS NULL, validated_at DESC, created_at DESC
   LIMIT 1
   ```
   `validated_at IS NULL` sorts first as `0` for non-null, so never-validated rows
   land last — SQLite has no `NULLS LAST`.

**Failure modes:**

| Condition | Response |
| --- | --- |
| User has zero keys | `428 { code: "no_key", error: "add an AI key in your profile to use this" }` |
| Explicit provider requested but not configured | `428 no_key`, message names the provider |
| Stored blob fails the GCM auth tag (`VaultError`) | `502 { code: "provider_error", error: "your stored key could not be read — remove it and add it again" }` |

The decrypt failure maps to `provider_error`, **not** `invalid_key`, for two
reasons: it keeps the response inside the six-code taxonomy, and a `401` would
trip the frontend's session-clearing path and log the user out for a server-side
storage problem.

**Invariants:**

- `req.ai.apiKey` is plaintext and request-scoped. No handler may pass `req.ai`
  to `res.json`, to a log call, or into a cached payload. The `AiRequest` type
  comment says so and the leak test enforces it.
- `loadUserKey` writes nothing to `ai_usage` — accounting is the feature route's
  job, after it knows whether the answer was cached.

---

## 7. Frontend design

### 7.1 Component tree

```
ProfilePage
├─ profile header card                      (existing, unchanged)
├─ <AiKeysSection />                        ← NEW, inserted here
│  ├─ <h3> ✦ AI & Keys                      font-numeric uppercase tracking-widest text-marigold
│  ├─ <VaultNote />                          plain-language disclosure, always visible
│  ├─ <ul>
│  │  ├─ <ProviderKeyRow provider="anthropic" />
│  │  ├─ <ProviderKeyRow provider="gemini" />
│  │  └─ <ProviderKeyRow provider="openai" />
│  │     ├─ <ProviderMark id />              gradient chip, no image asset
│  │     ├─ status pill  (see §7.3)
│  │     ├─ meta line: ····1234 · claude-sonnet-5 · validated 14 Aug
│  │     ├─ <AddKeyForm />                   rendered when unconfigured / replacing
│  │     └─ delete button → inline confirm   (matches TripRow's 🗑 affordance)
│  └─ <UsageSummary />                       hidden entirely when usage is empty
├─ "Waiting to hear" section                (existing)
├─ "Upcoming trips" section                 (existing)
└─ "Travel log" section                     (existing)
```

Shared, used by F1–F4 rather than by the profile page:

```
<KeyPrompt feature="itinerary" />
├─ ✦ headline naming the specific feature's value
├─ one-line explanation of BYOK
└─ <Link to="/profile#ai-keys"> Add your key → </Link>
```

`KeyPrompt` props:

```ts
interface KeyPromptProps {
  feature: "itinerary" | "packing" | "budget" | "search";
  /** Optional override of the default per-feature pitch. */
  headline?: string;
}
```

`AiKeysSection` renders `id="ai-keys"` on its wrapper so the `KeyPrompt` deep link
lands on it.

### 7.2 `web/src/lib/ai.ts`

```ts
import type { ProviderId, AiKeyPublic, UsageResponse, ErrorBody } from "./types";

export class AiClientError extends Error {
  readonly code: ErrorBody["code"];
  readonly retryAfter?: number;
}

export interface AiClient {
  listKeys(): Promise<AiKeyPublic[]>;
  saveKey(input: {
    provider: ProviderId;
    apiKey: string;
    model?: string;
    preferred?: boolean;
  }): Promise<AiKeyPublic>;
  deleteKey(provider: ProviderId): Promise<void>;
  setPreferred(provider: ProviderId): Promise<AiKeyPublic[]>;
  usage(): Promise<UsageResponse>;
}

/** Built from the auth context's authFetch, so there is one token source. */
export function createAiClient(
  authFetch: AuthState["authFetch"],
): AiClient;

export const PROVIDER_META: Record<ProviderId, {
  label: string;          // "Anthropic Claude"
  defaultModel: string;   // "claude-sonnet-5"
  gradient: string;       // CSS gradient for <ProviderMark />
  keyHint: string;        // "starts with sk-ant-"
  consoleUrl: string;     // where to get a key
}>;
```

`createAiClient` maps a non-2xx body into `AiClientError` carrying `code`, so
components branch on a code, never on a status number or a message substring.

### 7.3 The required change to `authFetch`

`web/src/lib/auth.tsx` currently does this on **every** 401:

```ts
if (res.status === 401) { persist(null, null); }
```

Since `POST /api/ai/keys` answers `401` when the *provider* rejects the API key,
pasting one bad key would sign the user out of Northstar Nomad. That is a real
bug this feature would introduce.

Fix — additive, no behaviour change for existing callers:

```ts
authFetch: <T>(
  url: string,
  init?: RequestInit,
  opts?: { signOutOn401?: boolean },   // default true
) => Promise<T>;
```

`createAiClient` passes `{ signOutOn401: false }` on `saveKey`, and inspects the
body's `code`: `"unauthenticated"` → rethrow so the app's normal session handling
runs; `"invalid_key"` → surface inline on the row.

### 7.4 The per-row state machine

```ts
type KeyRowState =
  | { status: "unconfigured" }
  | { status: "validating"; last4?: string }
  | { status: "connected"; key: AiKeyPublic }
  | { status: "error"; code: ErrorBody["code"]; message: string; key?: AiKeyPublic }
  | { status: "deleting"; key: AiKeyPublic };
```

Transitions:

| From | Event | To |
| --- | --- | --- |
| `unconfigured` | mount, `listKeys()` returns a row | `connected` |
| `unconfigured` | submit `AddKeyForm` | `validating` |
| `validating` | 200 | `connected` |
| `validating` | 401 `invalid_key` / 402 / 429 / 502 | `error` |
| `error` | edit the input | `unconfigured` (or `connected` if replacing) |
| `error` | resubmit | `validating` |
| `connected` | "Replace key" | `unconfigured` with the form open, `key` retained |
| `connected` | delete confirmed | `deleting` → `unconfigured` |
| `deleting` | request fails | `error` with `key` retained |

Rendering per state, in the existing night-sky vocabulary:

| State | Pill | Classes |
| --- | --- | --- |
| `unconfigured` | `Not connected` | `bg-raise text-muted ring-1 ring-white/5` |
| `validating` | `Checking…` | `bg-sky/15 text-sky ring-1 ring-sky/40`, `animate-twinkle` on the mark |
| `connected` | `✓ Connected — Claude Sonnet 5` | `bg-jade/15 text-jade ring-1 ring-jade/40` |
| `error` | `✗ That key was rejected` | `bg-rose/15 text-rose ring-1 ring-rose/40` |

Row shell reuses `TripRow`'s exact container classes —
`flex flex-wrap items-center justify-between gap-3 rounded-xl bg-raise p-4 ring-1 ring-white/5` —
so the section is visually indistinguishable from the trip list it sits above.
Section heading uses `font-numeric text-xs font-bold uppercase tracking-widest text-marigold`,
matching "✦ Waiting to hear". `<main>` already carries `animate-fade-up`.

Error copy is code-driven, never a raw server string echo:

| `code` | Copy |
| --- | --- |
| `invalid_key` | ✗ That key was rejected. Check you copied the whole thing. |
| `insufficient_credit` | ✗ The key works, but the account is out of credit. |
| `rate_limited` | ✗ Rate limited — try again in {retryAfter}s. |
| `provider_error` | ✗ Couldn't reach {provider}. Try again in a moment. |
| `bad_request` | ✗ That doesn't look like a {provider} key ({keyHint}). |

### 7.5 Input hygiene

- `<input type="password" autoComplete="off" spellCheck={false} name="ai-api-key">`
  with a "show" toggle (`type="text"`) so a paste can be eyeballed.
- `.trim()` on paste, and strip internal whitespace/newlines before submit —
  multi-line paste from a provider console is the single most common failure.
- The plaintext value lives in `useState` inside `AddKeyForm` only and is cleared
  on success, on unmount, and on navigation away. It is never lifted into context,
  never written to `localStorage`, and never included in a URL.
- After a successful save the component holds only `AiKeyPublic`.

### 7.6 `VaultNote` copy (verbatim — the PRD demands no buried disclosure)

> **Where your key lives.** It's encrypted (AES-256-GCM) before it touches our
> database and is only ever decrypted in memory to make a request you asked for.
> It never appears in a response, a log, or a URL. Delete it here any time and
> the row is gone immediately. We never make a call you didn't click.

---

## 8. Build order

Fifteen phases. Each is one focused commit into `feat/f0-byok-key-vault`, each
ships green on its own, and **no phase's tests depend on a later phase existing.**

---

### Phase 1 — `f0/01-ai-schema`

**Files:** `server/src/db.ts`, `server/src/db.test.ts` (new)

Append the four tables and two indexes from §2.1 to the existing `db.exec()` block.

**Tests** (`db.test.ts`)
- `creates ai_keys, ai_cache, ai_usage, ai_prefs tables`
- `enforces the (user_id, provider) composite primary key on ai_keys`
- `rejects a provider outside the CHECK constraint`
- `creates idx_ai_usage_user and idx_ai_cache_feature`
- `ai_cache has no user_id column`

---

### Phase 2 — `f0/02-vault-crypto`

**Files:** `server/src/ai/vault.ts`, `server/src/ai/vault.test.ts`

Full §4: `resolveMasterKey`, `getMasterKey`, `encryptApiKey`, `decryptApiKey`,
`VaultError`, derived-key memo, `__resetMasterKeyForTests`.

**Tests**
- `round-trips an api key through encrypt and decrypt`
- `produces a fresh salt and iv on every encrypt of the same plaintext`
- `produces different ciphertext for the same plaintext twice`
- `stores last4 as the final four characters of the plaintext`
- `ciphertext bytes contain no substring of the plaintext`
- `fails the GCM auth tag when the ciphertext is modified`
- `fails the GCM auth tag when the tag is modified`
- `fails the GCM auth tag when decrypting with a different master key`
- `throws VaultError("malformed") on a wrong-length iv`
- `falls back to the dev master key outside production and warns once`
- `throws VaultError("master_key_missing") when NODE_ENV=production and the var is unset`
- `throws when the production master key is shorter than 32 characters`
- `throws when production is configured with the built-in dev key`

---

### Phase 3 — `f0/03-boot-guard`

**Files:** `server/src/index.ts`, `server/src/routes/ai-boot.test.ts`, `README.md`

`assertVaultConfigured()` before `createApp()`; stderr message + `exit(1)`.
README gains the env-var table and corrects "No database".

**Tests**
- `exits non-zero when NODE_ENV=production and NOMAD_MASTER_KEY is unset`
  (`spawnSync("npx", ["tsx", "src/index.ts"], { env: { ...process.env, NODE_ENV: "production", NOMAD_MASTER_KEY: "", PORT: "0" }, cwd: serverRoot, timeout: 15_000 })` → `status === 1`)
- `prints a message naming NOMAD_MASTER_KEY on stderr`
- `does not bind a port before exiting` (stdout contains no "listening on")

Only the failure case is spawned — the success case would listen forever.

---

### Phase 4 — `f0/04-provider-contract`

**Files:** `server/src/ai/provider.ts`, `server/src/ai/http.ts`,
`server/src/ai/provider.test.ts`

The interface, the six-code taxonomy, `AI_ERROR_STATUS`, `AiError`,
`sendAiError`, and the `requestJson` helper. No adapters yet.

**Tests**
- `maps every AiErrorCode to its documented HTTP status`
- `AiError.toJSON exposes error, code, provider, retryAfter and nothing else`
- `AiError.toJSON never includes cause or stack`
- `AiError.from wraps an unknown throwable as provider_error`
- `sendAiError sets the Retry-After header for rate_limited`
- `requestJson converts a network failure into provider_error`
- `requestJson converts a timeout into provider_error`

---

### Phase 5 — `f0/05-fake-provider`

**Files:** `server/src/ai/providers/fake.ts`, `server/src/ai/registry.ts`,
`server/src/test-setup.ts`, `server/vitest.config.ts`,
`server/src/ai/providers/fake.test.ts`

The scriptable fake, the registry, and the setup file that sets `NOMAD_AI_FAKE=1`
and stubs `global.fetch` to throw. **After this phase, network access from a test
is impossible.**

**Tests**
- `validate resolves the scripted ValidationResult`
- `validate rejects with the scripted AiError`
- `complete consumes scripted completions in order`
- `complete runs the caller's parse function`
- `complete rejects with bad_output when parse throws`
- `complete returns deterministic token counts for identical input`
- `records every call with the api key it received`
- `registry returns fake providers for all three ids when NOMAD_AI_FAKE=1`
- `global fetch throws inside the test environment`

---

### Phase 6 — `f0/06-anthropic-adapter`

**Files:** `server/src/ai/providers/anthropic.ts`, `.../__fixtures__/anthropic.*.json`,
`server/src/ai/providers/anthropic.test.ts`

Adapter plus the four exported pure functions. Fixtures recorded for: tool-use
success, 401 auth error, 400 low-credit, 429, 529 overloaded.

**Tests**
- `builds a validate request with max_tokens 1 and the x-api-key header`
- `sends the schema verbatim as input_schema with forced tool_choice`
- `extracts the tool_use input block as the result`
- `throws bad_output when no tool_use block is present`
- `extracts input and output token counts from usage`
- `maps 401 authentication_error to invalid_key`
- `maps 403 permission_error to invalid_key`
- `maps a 400 credit-balance message to insufficient_credit`
- `maps 429 to rate_limited and reads retry-after`
- `maps 529 overloaded to provider_error with a retryAfter`
- `maps 500 to provider_error`
- `never puts the api key in a thrown error message`

---

### Phase 7 — `f0/07-gemini-adapter`

**Files:** `server/src/ai/providers/gemini.ts`, `.../__fixtures__/gemini.*.json`,
`server/src/ai/providers/gemini.test.ts`

**Tests**
- `validate calls models.get and sends the key as the x-goog-api-key header`
- `never places the api key in the request URL`
- `toVendorSchema strips additionalProperties and $schema`
- `toVendorSchema strips minimum, maximum, minItems and maxItems`
- `toVendorSchema emits propertyOrdering matching the property keys`
- `parses the JSON string in candidates[0].content.parts[0].text`
- `throws bad_output when finishReason is SAFETY`
- `throws bad_output when finishReason is MAX_TOKENS`
- `extracts usage from usageMetadata`
- `maps "API key not valid" to invalid_key`
- `maps PERMISSION_DENIED to invalid_key`
- `maps RESOURCE_EXHAUSTED with a billing message to insufficient_credit`
- `maps a plain 429 to rate_limited and parses retryDelay "27s" to 27`
- `maps 503 UNAVAILABLE to provider_error`

---

### Phase 8 — `f0/08-openai-adapter`

**Files:** `server/src/ai/providers/openai.ts`, `.../__fixtures__/openai.*.json`,
`server/src/ai/providers/openai.test.ts`

**Tests**
- `validate issues GET /v1/models with a bearer token`
- `sends response_format json_schema with strict true`
- `toVendorSchema sets additionalProperties false on every object`
- `toVendorSchema marks every property required`
- `uses max_completion_tokens rather than max_tokens`
- `omits temperature for gpt-5`
- `sends temperature for a non-reasoning model`
- `parses choices[0].message.content as JSON`
- `throws bad_output on a refusal`
- `throws bad_output when finish_reason is length`
- `maps 401 invalid_api_key to invalid_key`
- `maps 429 insufficient_quota to insufficient_credit`
- `maps a plain 429 to rate_limited`
- `maps 404 model_not_found to provider_error`

---

### Phase 9 — `f0/09-keystore`

**Files:** `server/src/ai/keystore.ts`, `server/src/ai/keystore.test.ts`

`saveKey` / `listKeys` / `deleteKey` / `setPreferred` / `selectKey` against the
real SQLite database. No HTTP yet — this phase is pure data access.

**Tests**
- `saveKey inserts a row and returns the redacted shape`
- `saveKey upserts on a second save for the same provider`
- `saveKey rotates the salt and iv on upsert`
- `saveKey marks the first key preferred automatically`
- `listKeys returns an empty array for a user with no keys`
- `listKeys never returns ciphertext, iv, tag or salt`
- `listKeys is scoped to one user`
- `deleteKey returns false when nothing was configured`
- `deleteKey clears a matching ai_prefs row in the same transaction`
- `selectKey returns null for a user with no keys`
- `selectKey honours an explicit provider argument`
- `selectKey falls back to the stored preference`
- `selectKey falls back to the most recently validated key`
- `selectKey ignores a stored preference whose key row was deleted`
- `selectKey throws provider_error when the stored blob will not decrypt`

---

### Phase 10 — `f0/10-ai-keys-routes`

**Files:** `server/src/routes/ai-keys.ts`, `server/src/app.ts`,
`server/src/routes/ai-keys.test.ts`

`POST` / `GET` / `DELETE /api/ai/keys`, mounted in `app.ts`. Backed by the fake
registry, so no network.

**Tests**
- `saves a key and returns provider, last4, model and validatedAt`
- `defaults the model to the provider default when omitted`
- `accepts an explicit model override`
- `401s every /api/ai/keys route without a bearer token`
- `returns code "unauthenticated" rather than "invalid_key" for a missing token`
- `400s an unknown provider`
- `400s a malformed anthropic key shape`
- `400s a key containing a newline`
- `401s with code "invalid_key" when the provider rejects the key`
- `402s when the provider reports insufficient credit`
- `429s with a Retry-After header when the provider rate limits validation`
- `502s when the provider is unreachable`
- `writes no row when validation fails`
- `replaces an existing key for the same provider without creating a duplicate`
- `lists an empty array for a new user`
- `keeps each user's keys private`
- `deletes a configured key and returns 204`
- `404s deleting a provider that was never configured`
- `404s deleting another user's key`
- **`never returns the plaintext key from any /api/ai endpoint`** ← §9.2
- **`stores no plaintext key bytes in the ai_keys table`**

---

### Phase 11 — `f0/11-load-user-key`

**Files:** `server/src/ai/loadUserKey.ts`, `server/src/routes/ai-keys.ts`
(adds `PUT /api/ai/keys/preferred`), `server/src/ai/loadUserKey.test.ts`

The middleware plus the preference endpoint. Tests mount a throwaway probe route
inside the test file that echoes `req.ai.providerId` — never the key.

**Tests**
- `428 no_key when the user has configured nothing`
- `selects the explicitly requested provider from the body`
- `selects the explicitly requested provider from the query string`
- `428 no_key naming the provider when an explicit one is not configured`
- `does not silently fall back when an explicit provider is unavailable`
- `selects the stored preference when no explicit provider is given`
- `selects the most recently validated key when no preference is stored`
- `hands the decrypted plaintext key to the provider adapter`
- `502 provider_error when the stored ciphertext has been tampered with`
- `runs after requireAuth and 401s without a token`
- `PUT /api/ai/keys/preferred switches the default and returns the full list`
- `PUT /api/ai/keys/preferred 404s for an unconfigured provider`

---

### Phase 12 — `f0/12-ai-cache`

**Files:** `server/src/ai/cache.ts`, `server/src/ai/cache.test.ts`

Cache key derivation and get/put against the real `ai_cache` table. Nothing calls
it yet — F1 will.

**Tests**
- `produces a stable 64-character hex key for identical input`
- `produces the same key regardless of options key order`
- `produces a different key when the model changes`
- `produces a different key when the date range changes`
- `omits undefined fields rather than hashing the string "undefined"`
- **`produces an identical key for two different users with identical input`**
- `getCached returns null on a miss`
- `getCached returns the stored payload on a hit`
- `getCached returns null when the entry is older than maxAgeMs`
- `putCached overwrites an existing entry for the same key`
- `round-trips a nested object payload without mutation`

---

### Phase 13 — `f0/13-usage-accounting`

**Files:** `server/src/ai/usage.ts`, `server/src/routes/ai-keys.ts`
(adds `GET /api/ai/usage`), `server/src/ai/usage.test.ts`

**Tests**
- `recordUsage inserts one row per call`
- `usageSummary groups by feature`
- `usageSummary counts cached calls separately from total calls`
- `usageSummary sums input and output tokens`
- `usageSummary returns an empty array for a user with no usage`
- `usageSummary is scoped to one user`
- `GET /api/ai/usage returns usage and totals`
- `GET /api/ai/usage 401s without a token`
- `deleting a key preserves historical usage rows`

---

### Phase 14 — `f0/14-web-ai-client`

**Files:** `web/src/lib/ai.ts`, `web/src/lib/types.ts`, `web/src/lib/auth.tsx`

Typed client, shared types mirroring the server, `PROVIDER_META`, and the
`signOutOn401` option on `authFetch`.

**Verification** — `web/` has no test runner and this design adds none.
- `npm run typecheck` in `web/` passes
- `npm run build` passes
- Manual: existing 401 behaviour unchanged on `/api/trips` (expired token still
  signs the user out)
- Manual: `saveKey` with a bad key surfaces `invalid_key` and the session survives

---

### Phase 15 — `f0/15-profile-ai-section`

**Files:** `web/src/components/Ai/*.tsx`, `web/src/pages/ProfilePage.tsx`,
`docs/THREAT-MODEL.md`, `README.md`

`AiKeysSection`, `ProviderKeyRow`, `AddKeyForm`, `ProviderMark`, `UsageSummary`,
`VaultNote`, `KeyPrompt`; wire into the profile page; write the threat model.

**Verification**
- `npm run typecheck` + `npm run build` in `web/`
- Manual: paste a valid key → row moves `unconfigured → validating → connected`
  in under 30 seconds (PRD success criterion)
- Manual: paste a bad key → `error` state, correct copy, still signed in
- Manual: delete → confirm → row returns to `unconfigured`
- Manual: `/profile#ai-keys` from a `<KeyPrompt />` scrolls to the section
- Manual: DevTools Network tab — no request body or URL contains the pasted key
- Manual: three rows render correctly at 375 px width

---

## 9. Test strategy

Vitest + supertest, matching the existing 60-test suite: a module-level
`const app = createApp()`, a `register(email)` helper returning a token, unique
emails per test to avoid cross-test collisions, and `expect(res.status).toBe(...)`
assertions. `NODE_ENV=test` is already set by vitest, so `db.ts` selects
`:memory:` and every run starts from a clean real SQLite database — the schema is
real, only the file is not.

### 9.1 Network isolation

`server/src/test-setup.ts`, registered via `setupFiles` in a new
`vitest.config.ts`:

```ts
process.env.NOMAD_AI_FAKE = "1";
globalThis.fetch = (() => {
  throw new Error("network access is not allowed in tests");
}) as typeof fetch;
```

Two independent layers: the registry hands back fakes, *and* `fetch` throws. If
someone later imports a real adapter directly, the suite fails loudly instead of
quietly hitting a vendor and burning a real key.

### 9.2 The leak test (`ai-keys.test.ts`)

The PRD's hardest requirement: grepping the response surface yields nothing.

```
CANARY = "sk-ant-api03-LEAKCANARY-7f3a9c2e5b1d8046a2c9"
```

1. Register a user; script the fake provider to accept the key.
2. `POST /api/ai/keys` with `CANARY`.
3. Call **every** endpoint that could plausibly echo it:
   - `POST /api/ai/keys` (the save response itself)
   - `POST /api/ai/keys` again (the upsert response)
   - `POST /api/ai/keys` with a deliberately bad key (the error response)
   - `GET /api/ai/keys`
   - `PUT /api/ai/keys/preferred`
   - `GET /api/ai/usage`
   - `DELETE /api/ai/keys/anthropic`
   - `GET /api/auth/me`, `GET /api/trips` (adjacent surfaces)
4. For each: assert `JSON.stringify(res.body)` contains neither `CANARY` nor its
   middle 16 characters (`CANARY.slice(8, 24)`) — the substring check catches a
   partially-redacted leak that a full-string check would miss.
5. Also assert on the raw `res.text`, not just the parsed body, so a leak in a
   non-JSON error page is caught.

Test name: `never returns the plaintext key from any /api/ai/* endpoint`.

Companion test — the storage layer:

```ts
const row = db.prepare("SELECT ciphertext, last4 FROM ai_keys WHERE user_id = ?").get(id);
expect(row.ciphertext.toString("utf8")).not.toContain(CANARY.slice(8, 24));
expect(row.ciphertext.toString("latin1")).not.toContain(CANARY.slice(8, 24));
expect(row.last4).toBe(CANARY.slice(-4));
```

Test name: `stores no plaintext key bytes in the ai_keys table`.

### 9.3 The tamper test (`vault.test.ts`)

```ts
const sealed = encryptApiKey("sk-ant-api03-abcdefghijklmnop");
sealed.ciphertext[0] ^= 0xff;                       // flip one bit
expect(() => decryptApiKey(sealed)).toThrow(VaultError);
expect(() => decryptApiKey(sealed)).toThrow(/auth/i);
```

Three variants, each a named test:
- `fails the GCM auth tag when the ciphertext is modified`
- `fails the GCM auth tag when the tag is modified` (flip a byte in `tag`)
- `fails the GCM auth tag when the salt is modified` (wrong salt → wrong derived
  key → same failure path, which is the important structural property)

Each additionally asserts **no plaintext is returned** — the throw is the only
outcome; there is no "partial decrypt" branch.

### 9.4 The wrong-master-key test (`vault.test.ts`)

```ts
process.env.NOMAD_MASTER_KEY = "master-key-number-one-0123456789abcdef";
__resetMasterKeyForTests();
const sealed = encryptApiKey(SECRET);

process.env.NOMAD_MASTER_KEY = "master-key-number-two-0123456789abcdef";
__resetMasterKeyForTests();
expect(() => decryptApiKey(sealed)).toThrow(VaultError);
```

`afterEach` restores the original env and calls `__resetMasterKeyForTests()`.
This is exactly why `resolveMasterKey(env)` is a pure function with a reset hook
rather than a module-level constant read once at import.

Test name: `fails the GCM auth tag when decrypting with a different master key`.

### 9.5 The cache-isolation test (`cache.test.ts`)

```ts
const a = cacheKey({ feature: "itinerary", destinationId: "goa", start: "2026-12-25", end: "2026-12-28", model: "claude-sonnet-5" });
const b = cacheKey({ /* identical input, different user in scope */ });
expect(a).toBe(b);
```

Enforces the cluster spec's "cache keys contain no user id" invariant
structurally: identical inputs from two different users must collide, because
that is the whole point of a global cache.

Test name: `produces an identical key for two different users with identical input`.

### 9.6 Adapter testing from fixtures, with zero network

Each adapter exports `mapError`, `toVendorSchema`, `extractJson`, and
`extractUsage` as **pure functions**. The tests import those and feed them
recorded JSON from `__fixtures__/`. No HTTP client is constructed, no `fetch` is
called, no key is needed.

```ts
import errors from "./__fixtures__/anthropic.errors.json";

it("maps a 400 credit-balance message to insufficient_credit", () => {
  const err = mapError(400, errors.lowCredit, new Headers());
  expect(err.code).toBe("insufficient_credit");
  expect(err.status).toBe(402);
});
```

Request-shape assertions use an injected transport rather than a live call:
`createAnthropicProvider({ transport })` where `transport` matches `requestJson`'s
signature and simply records its arguments and returns a fixture. That is the
same dependency-injection seam the real adapter uses in production — it just gets
a different function in tests.

Fixtures are recorded once by hand from published vendor error documentation and
committed. They are data, not snapshots — no auto-update, so a fixture change is
always a deliberate, reviewed edit.

### 9.7 Test-count expectation

Roughly 115 new tests across phases 1–13, taking the suite from 60 to ~175. Every
one runs offline in under three seconds total; the only slow component is scrypt,
which the vault tests hit about 25 times (~2 s).

---

## 10. Risks & edge cases

### 10.1 Behavioural edge cases

| Case | Behaviour |
| --- | --- |
| **Duplicate provider save (upsert)** | `INSERT ... ON CONFLICT(user_id, provider) DO UPDATE SET ciphertext, iv, tag, salt, last4, model, validated_at`. `created_at` is preserved — it records when the user first connected that provider. A fresh salt and IV are generated, so the old derived key is dead. No duplicate row is possible: the composite PK forbids it at the database level. |
| **Delete a non-configured provider** | `info.changes === 0` → `404 { code: "not_found" }`. Same shape as `trips.ts` returning 404 for a missing or foreign trip. |
| **Delete another user's key** | The `DELETE` is scoped `WHERE user_id = ? AND provider = ?`, so `changes === 0` → `404`. Indistinguishable from "not configured" — no cross-user existence oracle. |
| **User with zero keys hits an F1–F4 route** | `loadUserKey` returns `428 { code: "no_key" }` before any provider work. The client renders `<KeyPrompt />`. 428 (Precondition Required) is deliberately not 401 or 403: it means "do a thing first", and it will never trip the frontend's session-clearing path. |
| **Concurrent writes** | better-sqlite3 is synchronous and serialises within the process; SQLite's WAL mode (already enabled) handles multi-process. Two simultaneous saves for the same `(user_id, provider)` serialise into two upserts and the last writer wins — both keys were valid, so either outcome is correct. `deleteKey` wraps the `ai_keys` delete and the `ai_prefs` cleanup in `db.transaction()` so a user never ends up preferring a provider they no longer have. There is no read-modify-write anywhere in the keystore, so there is no lost-update window. |
| **Key valid at save, revoked later** | `validated_at` is a point-in-time fact, not a live guarantee. The next feature call returns `401 invalid_key`; the UI moves that row to `error` with "this key was rejected — it may have been revoked". F0 does not re-validate in the background. |
| **User configures a model the key can't access** | `validate()` for Anthropic exercises the model directly, so a 404 surfaces at save time. Gemini's `models.get` also 404s on an unknown model. OpenAI's `GET /v1/models` does **not** check the model, so a bad OpenAI model id only fails at first use, as `provider_error` naming the model. Documented, accepted — the alternative is an extra billed call at save. |
| **Key pasted with a trailing newline** | Stripped client-side and server-side before the shape regex runs. Without this, every key from a console "copy" button fails validation for a reason the user cannot see. |
| **Vendor changes its key prefix** | `KEY_SHAPE` is one constant, one line per provider. The regexes are deliberately loose (prefix + character class + length floor) rather than exact-length, so a suffix format change does not break saves. |
| **`ai_prefs` points at a deleted key** | The selection query joins `ai_prefs` to `ai_keys`; a dangling preference silently falls through to rule 3. Belt and braces alongside the transactional cleanup. |
| **All three keys configured, none preferred** | Rule 3: most recently validated. Deterministic tie-break by `created_at DESC`, then by the PK order. |

### 10.2 Security risks

| Risk | Mitigation |
| --- | --- |
| **We now hold user API keys** | AES-256-GCM at rest with a per-save random salt; master key required at boot in production; plaintext exists only inside a single request's scope. `docs/THREAT-MODEL.md` states plainly: an attacker with the `data.sqlite` file alone gets nothing usable; they need the master key too, which lives in the environment, not the repo and not the database. |
| **Key leaks into a log line** | `http.ts` logs nothing. `AiError.toJSON()` emits four whitelisted fields and never `cause`. No `console.log` anywhere in `src/ai/`. Gemini uses a header, not a query param, so the key cannot reach an access log. Enforced by the §9.2 leak test. |
| **Key leaks into a response** | `listKeys` uses an explicit column list; `SELECT *` on `ai_keys` is banned by convention and by the leak test. `req.ai` is documented as never-serialisable. |
| **The two-meanings-of-401 bug** | Distinguished by `code`; `authFetch` gains `signOutOn401`. Without this, a typo in a pasted key signs the user out of the whole product. Called out as a required change in Phase 14. |
| **Key validation as a brute-force oracle** | `POST /api/ai/keys` makes a live upstream call, so an attacker with a stolen session could use us as a key-testing proxy. Mitigation: an in-process per-user throttle on `POST /api/ai/keys` — 10 attempts per hour, `429 rate_limited` beyond that. In-process is honest for a single-instance deployment; noted as needing a shared store if the app is ever horizontally scaled. |
| **Dev master key shipped to production** | `resolveMasterKey` explicitly rejects the known dev constant when `NODE_ENV === "production"`, so copying `.env.example` into production fails at boot rather than encrypting real keys under a public value. |
| **Cross-user cache leakage** | `ai_cache` has no `user_id` column to leak through, prompts receive no user-identifying input (a binding constraint on F1–F4), and §9.5 asserts key equality across users. |
| **IDOR on keys and usage** | Every statement is scoped by `req.userId`, mirroring `trips.ts`. Cross-user access returns 404, never 403 — no existence oracle. |

### 10.3 Operational risks

| Risk | Mitigation |
| --- | --- |
| **Rotating `NOMAD_MASTER_KEY` bricks every stored key** | Documented in the threat model: rotation requires decrypt-with-old / re-encrypt-with-new. `vault.ts` reserves the name `rotate()` (per the cluster spec's file layout) but F0 ships no implementation. The interim recovery path is user-visible and honest: rows fail to decrypt, `loadUserKey` returns `provider_error` with "remove it and add it again". |
| **scrypt cost on a hot path** | ~60–90 ms per derivation, once per AI request. The derived-key memo (§4.5) removes it for repeat requests. If it ever bites, the tunable is `N`, in one place. |
| **Vendor API drift across three vendors** | One narrow interface, one adapter each, pure mapping functions with fixture tests. A vendor change breaks exactly one adapter's tests and cannot break the other two or any route. |
| **Adding a fourth provider (or a local model)** | Implement `AiProvider`, add one `KEY_SHAPE` entry, one `PROVIDER_META` entry, one CHECK-constraint value, one registry entry. No route, middleware, or frontend logic changes. That is the acceptance test for whether this abstraction earned its place. |
| **F0 merges with nothing consuming it** | Intended — it ships dark. `cache.ts` and `usage.ts` are built and tested in F0 but have zero callers until F1. `GET /api/ai/usage` correctly returns `[]`, and `UsageSummary` renders nothing rather than an empty table. |

---

### Out of scope for F0 (stated so review does not ask for it)

- Key rotation tooling, expiry tracking, background re-validation
- Team or shared keys; any Northstar-supplied key or billing relationship
- Spend caps or per-user budget enforcement (usage is *reported*, not *enforced*)
- Local model adapters (Ollama, LM Studio) — the interface accommodates them, no adapter ships
- Streaming responses
- A web test runner (`web/` verification is typecheck + build + a manual checklist)
- Prompt modules (`src/ai/prompts/*`) — those belong to F1–F4

---

## Implementation notes from reading the codebase

Two findings are load-bearing for the phases below.

1. **`web/src/lib/auth.tsx:112` signs the user out on any 401.** The handler
   calls `persist(null, null)` unconditionally. Because `POST /api/ai/keys`
   answers 401 when the *provider* rejects the pasted key, a user who fat-fingers
   their Anthropic key would be signed out of Northstar Nomad entirely. Phase 14
   fixes this with an additive `signOutOn401` option rather than changing the
   default behaviour of existing calls.

2. **`server/src/db.ts` has no migration runner** — just one `db.exec()` of
   `CREATE TABLE IF NOT EXISTS` statements. This is why the provider preference
   lives in a new `ai_prefs` table rather than as a column on `users` or
   `ai_keys`: adding a column would require `ALTER TABLE` with swallowed
   errors, while a new table is idempotent and keeps the `ai_keys` DDL
   byte-identical to the cluster spec.

`server/` also has no `vitest.config.ts` today. Phase 5 adds one solely to
register `src/test-setup.ts`, which is what makes network access from a test
structurally impossible rather than merely discouraged.
