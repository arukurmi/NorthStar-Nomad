import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * The master key every non-production process falls back to. Public on purpose:
 * it lives in git, so anything encrypted under it is readable by anyone with
 * this repo. Production refuses to boot with it.
 */
export const DEV_MASTER_KEY = "northstar-dev-master-key-do-not-use-in-production";

/** N=16384 is the documented default cost (~60–90 ms). maxmem must be raised
 *  explicitly or N=16384 with r=8 exceeds Node's 32 MB default and throws. */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MIN_MASTER_KEY_LENGTH = 32;
const DERIVED_KEY_CACHE_MAX = 64;

const MISSING_MSG = "NOMAD_MASTER_KEY is required when NODE_ENV=production.";
const SHORT_MSG = `NOMAD_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters when NODE_ENV=production.`;
const DEV_IN_PROD_MSG =
  "NOMAD_MASTER_KEY is the built-in development key, which is public — refusing to use it when NODE_ENV=production.";
const DEV_WARNING =
  "⚠️  NOMAD_MASTER_KEY is not set — using the built-in DEVELOPMENT key.\n" +
  "   Stored AI keys are readable by anyone with this repo. Never ship this.";

export type VaultErrorReason = "auth_tag" | "malformed" | "master_key_missing";

export class VaultError extends Error {
  readonly reason: VaultErrorReason;

  constructor(reason: VaultErrorReason, message: string) {
    super(message);
    this.name = "VaultError";
    this.reason = reason;
  }
}

export interface SealedKey {
  ciphertext: Buffer; // variable length == plaintext length
  iv: Buffer; // 12 bytes
  tag: Buffer; // 16 bytes
  salt: Buffer; // 16 bytes
  last4: string; // 4 chars, plaintext tail — the only plaintext we persist
}

let masterKey: Buffer | null = null;
let devWarningPrinted = false;

/**
 * Derived keys, not plaintext API keys — scrypt is ~60–90 ms and a user would
 * otherwise pay it on every AI request. Keyed by salt alone, which is only safe
 * because the master key is resolved once per process and can change only via
 * __resetMasterKeyForTests, which clears this map.
 */
const derivedKeys = new Map<string, Buffer>();

/** Pure, injectable core — this is what the unit tests drive. */
export function resolveMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.NOMAD_MASTER_KEY?.trim();
  const isProd = env.NODE_ENV === "production";

  if (isProd) {
    if (!raw) throw new VaultError("master_key_missing", MISSING_MSG);
    if (raw.length < MIN_MASTER_KEY_LENGTH) {
      throw new VaultError("master_key_missing", SHORT_MSG);
    }
    if (raw === DEV_MASTER_KEY) {
      throw new VaultError("master_key_missing", DEV_IN_PROD_MSG);
    }
    return Buffer.from(raw, "utf8");
  }

  if (raw) return Buffer.from(raw, "utf8");
  if (!devWarningPrinted) {
    devWarningPrinted = true;
    console.warn(DEV_WARNING);
  }
  return Buffer.from(DEV_MASTER_KEY, "utf8");
}

/** Resolves and memoises the master key. Throws VaultError in production. */
export function getMasterKey(): Buffer {
  masterKey ??= resolveMasterKey(process.env);
  return masterKey;
}

/** Called from index.ts before the app is built. Exits(1) in production. */
export function assertVaultConfigured(): void {
  try {
    getMasterKey();
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    process.stderr.write(
      `FATAL: ${err.message}\n` +
        "It encrypts every user's AI API key at rest (AES-256-GCM).\n" +
        "Generate one with:  openssl rand -base64 48\n" +
        "Then set it in the environment and restart. Refusing to start.\n",
    );
    process.exit(1);
  }
}

/** Drops the memoised master key, the derived-key cache and the dev warning. */
export function __resetMasterKeyForTests(): void {
  masterKey = null;
  devWarningPrinted = false;
  derivedKeys.clear();
}

function deriveKey(salt: Buffer): Buffer {
  const memoKey = salt.toString("hex");
  const memo = derivedKeys.get(memoKey);
  if (memo) return memo;
  const derived = scryptSync(getMasterKey(), salt, KEY_BYTES, SCRYPT);
  if (derivedKeys.size >= DERIVED_KEY_CACHE_MAX) {
    const oldest = derivedKeys.keys().next().value;
    if (oldest !== undefined) derivedKeys.delete(oldest);
  }
  derivedKeys.set(memoKey, derived);
  return derived;
}

/** Encrypts one API key under a fresh random salt + iv. */
export function encryptApiKey(plaintext: string): SealedKey {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  // getAuthTag is only valid after final().
  return { ciphertext, iv, tag: cipher.getAuthTag(), salt, last4: plaintext.slice(-4) };
}

/** Decrypts. Throws VaultError("auth_tag") on tamper or wrong master key. */
export function decryptApiKey(sealed: Omit<SealedKey, "last4">): string {
  const { ciphertext, iv, tag, salt } = sealed;
  if (
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES ||
    salt.length !== SALT_BYTES
  ) {
    throw new VaultError(
      "malformed",
      "the stored key blob has the wrong shape and was not decrypted",
    );
  }
  // Derive outside the try so a missing master key surfaces as itself.
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
  decipher.setAuthTag(tag); // must be before final()
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // final() is where GCM verifies the tag. Drop the original message and any
    // partially decrypted bytes on the floor — there is no partial-decrypt path.
    throw new VaultError(
      "auth_tag",
      "could not authenticate the stored key — wrong master key or tampered data",
    );
  }
}
