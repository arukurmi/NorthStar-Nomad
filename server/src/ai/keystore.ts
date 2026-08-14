import { db } from "../db.js";
import { AiError, type ProviderId } from "./provider.js";
import { decryptApiKey, encryptApiKey, VaultError } from "./vault.js";

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
  apiKey: string; // plaintext, request-scoped only
  model: string;
}

/** What a stored row looks like once the blobs come back from SQLite. */
interface SealedRow {
  provider: ProviderId;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  salt: Buffer;
  model: string | null;
}

/**
 * Every read of ai_keys that reaches a client names its columns. `SELECT *` is
 * banned here — that single rule is what keeps the blobs structurally unable to
 * reach a response body.
 */
const PUBLIC_COLUMNS = `
  k.provider                  AS provider,
  k.last4                     AS last4,
  k.model                     AS model,
  k.validated_at              AS validatedAt,
  (p.provider IS NOT NULL)    AS preferred
`;

interface PublicRow {
  provider: ProviderId;
  last4: string;
  model: string | null;
  validatedAt: string | null;
  preferred: number;
}

function toPublic(row: PublicRow): AiKeyPublic {
  return {
    provider: row.provider,
    last4: row.last4,
    model: row.model ?? "",
    validatedAt: row.validatedAt,
    preferred: row.preferred === 1,
  };
}

const selectPublic = db.prepare(`
  SELECT ${PUBLIC_COLUMNS}
  FROM ai_keys k
  LEFT JOIN ai_prefs p
    ON p.user_id = k.user_id AND p.provider = k.provider
  WHERE k.user_id = ?
  ORDER BY k.provider
`);

const selectOnePublic = db.prepare(`
  SELECT ${PUBLIC_COLUMNS}
  FROM ai_keys k
  LEFT JOIN ai_prefs p
    ON p.user_id = k.user_id AND p.provider = k.provider
  WHERE k.user_id = ? AND k.provider = ?
`);

const upsertKey = db.prepare(`
  INSERT INTO ai_keys
    (user_id, provider, ciphertext, iv, tag, salt, last4, model, validated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, provider) DO UPDATE SET
    ciphertext   = excluded.ciphertext,
    iv           = excluded.iv,
    tag          = excluded.tag,
    salt         = excluded.salt,
    last4        = excluded.last4,
    model        = excluded.model,
    validated_at = excluded.validated_at
`);

const upsertPref = db.prepare(`
  INSERT INTO ai_prefs (user_id, provider) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider
`);

const countKeys = db.prepare(
  "SELECT COUNT(*) AS n FROM ai_keys WHERE user_id = ?",
);

/**
 * Upserts on the (user_id, provider) composite primary key, so a duplicate save
 * replaces the credential rather than failing. `created_at` is deliberately not
 * in the DO UPDATE list — it records when the user first connected that
 * provider.
 */
export function saveKey(args: {
  userId: number;
  provider: ProviderId;
  apiKey: string;
  model: string;
  validatedAt: string;
  preferred: boolean;
}): AiKeyPublic {
  const sealed = encryptApiKey(args.apiKey);

  const write = db.transaction(() => {
    const { n } = countKeys.get(args.userId) as { n: number };
    upsertKey.run(
      args.userId,
      args.provider,
      sealed.ciphertext,
      sealed.iv,
      sealed.tag,
      sealed.salt,
      sealed.last4,
      args.model,
      args.validatedAt,
    );
    // A user's first key becomes their default without them asking: otherwise
    // the very first AI request would have no provider to select.
    if (args.preferred || n === 0) upsertPref.run(args.userId, args.provider);
  });
  write();

  return toPublic(selectOnePublic.get(args.userId, args.provider) as PublicRow);
}

export function listKeys(userId: number): AiKeyPublic[] {
  return (selectPublic.all(userId) as PublicRow[]).map(toPublic);
}

/** false when nothing was configured for that provider (→ 404). */
export function deleteKey(userId: number, provider: ProviderId): boolean {
  // One transaction so a user is never left preferring a provider whose key
  // has just gone. Historical ai_usage rows are kept on purpose.
  const remove = db.transaction(() => {
    const info = db
      .prepare("DELETE FROM ai_keys WHERE user_id = ? AND provider = ?")
      .run(userId, provider);
    if (info.changes === 0) return false;
    db.prepare("DELETE FROM ai_prefs WHERE user_id = ? AND provider = ?").run(
      userId,
      provider,
    );
    return true;
  });
  return remove();
}

/** false when the user has no key for that provider (→ 404). */
export function setPreferred(userId: number, provider: ProviderId): boolean {
  const owned = db
    .prepare("SELECT 1 FROM ai_keys WHERE user_id = ? AND provider = ?")
    .get(userId, provider);
  if (!owned) return false;
  upsertPref.run(userId, provider);
  return true;
}

const selectExplicit = db.prepare(`
  SELECT provider, ciphertext, iv, tag, salt, model
  FROM ai_keys
  WHERE user_id = ? AND provider = ?
`);

/** Joined, not two-stepped, so a dangling preference falls through to rule 3. */
const selectPreferred = db.prepare(`
  SELECT k.provider, k.ciphertext, k.iv, k.tag, k.salt, k.model
  FROM ai_prefs p
  JOIN ai_keys k ON k.user_id = p.user_id AND k.provider = p.provider
  WHERE p.user_id = ?
`);

/** `validated_at IS NULL` sorts 0 for non-null — SQLite has no NULLS LAST. */
const selectNewest = db.prepare(`
  SELECT provider, ciphertext, iv, tag, salt, model
  FROM ai_keys
  WHERE user_id = ?
  ORDER BY validated_at IS NULL, validated_at DESC, created_at DESC
  LIMIT 1
`);

/**
 * Selection rule, in order: explicit `prefer` → ai_prefs → most recently
 * validated. Returns null when the user has no usable key — including when an
 * explicit `prefer` was given and that provider is not configured, because a
 * caller who named a provider must not be silently handed a different one.
 *
 * Throws AiError("provider_error") if the stored blob will not decrypt.
 */
export function selectKey(
  userId: number,
  prefer?: ProviderId,
): DecryptedKey | null {
  const row = (
    prefer
      ? selectExplicit.get(userId, prefer)
      : (selectPreferred.get(userId) ?? selectNewest.get(userId))
  ) as SealedRow | undefined;
  if (!row) return null;

  try {
    return {
      providerId: row.provider,
      apiKey: decryptApiKey({
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        salt: row.salt,
      }),
      model: row.model ?? "",
    };
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    // provider_error, not invalid_key: a 401 would trip the frontend's
    // session-clearing path and sign the user out for a storage problem.
    throw new AiError(
      "provider_error",
      "your stored key could not be read — remove it and add it again",
      { provider: row.provider, cause: err },
    );
  }
}
