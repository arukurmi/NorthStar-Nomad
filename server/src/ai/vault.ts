import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

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
const MIN_MASTER_KEY_BYTES = 32;
const DERIVED_KEY_CACHE_MAX = 64;

/**
 * Environment variables no developer sets by hand: a platform sets them on the
 * host it owns. Their presence means this process is deployed — serving real
 * people's keys — whatever NODE_ENV happens to say. `CI` is deliberately absent:
 * a CI runner is not a deployed host and its tests need the dev fallback.
 */
const DEPLOY_MARKERS = [
  "RENDER", // Render
  "K_SERVICE", // Cloud Run / Knative
  "DYNO", // Heroku
  "FLY_APP_NAME", // Fly.io
  "VERCEL", // Vercel
  "AWS_EXECUTION_ENV", // Lambda / App Runner
  "KUBERNETES_SERVICE_HOST", // any in-cluster pod
  "WEBSITE_INSTANCE_ID", // Azure App Service
] as const;

const MISSING_MSG = "NOMAD_MASTER_KEY is required when NODE_ENV=production.";
const WEAK_MSG =
  `NOMAD_MASTER_KEY must carry at least ${MIN_MASTER_KEY_BYTES} bytes of key ` +
  "material — it has to decode, as base64 or hex, to that many bytes. A count " +
  "of characters is not a measure of strength.";
const DEV_IN_PROD_MSG =
  "NOMAD_MASTER_KEY contains the built-in development key, which is public — refusing to use it on a production or deployed host.";
const DEPLOYED_MSG =
  "NOMAD_MASTER_KEY is required: this looks like a deployed host " +
  `(${DEPLOY_MARKERS.join(", ")}), so the public built-in development key is refused.`;
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
 *
 * It holds *promises*, so two concurrent requests sharing a salt do the work
 * once rather than twice.
 */
const derivedKeys = new Map<string, Promise<Buffer>>();

/**
 * True when a platform marker says this process runs on infrastructure rather
 * than on a laptop. Used to refuse the public dev key on a host that never set
 * NODE_ENV — the failure mode that would encrypt real users' keys under a
 * constant committed to this repository.
 */
export function looksDeployed(env: NodeJS.ProcessEnv): boolean {
  return DEPLOY_MARKERS.some((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Bytes of actual key material behind a master key, read as base64 and as hex
 * and scored on the more generous of the two. `"a".repeat(32)` is 32 characters
 * and 24 base64 bytes of a single repeated symbol; measuring the decode is what
 * separates a real `openssl rand -base64 48` value from a padded word.
 */
function keyMaterialBytes(raw: string): number {
  const asBase64 = Buffer.from(raw, "base64").length;
  const asHex = /^(?:[0-9a-fA-F]{2})+$/.test(raw)
    ? Buffer.from(raw, "hex").length
    : 0;
  return Math.max(asBase64, asHex);
}

/** Pure, injectable core — this is what the unit tests drive. */
export function resolveMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.NOMAD_MASTER_KEY?.trim();
  // A deployed host is held to the production bar even if it never set
  // NODE_ENV — otherwise the fallback below silently seals real keys with a
  // constant that is public in git.
  const deployed = looksDeployed(env);
  const isProd = env.NODE_ENV === "production" || deployed;

  if (isProd) {
    if (!raw) {
      throw new VaultError(
        "master_key_missing",
        deployed && env.NODE_ENV !== "production" ? DEPLOYED_MSG : MISSING_MSG,
      );
    }
    // Containment, not equality: `DEV_MASTER_KEY + "!"` is still the public dev
    // key with a character stapled on, and it is long enough to pass every
    // other check.
    if (raw.toLowerCase().includes(DEV_MASTER_KEY)) {
      throw new VaultError("master_key_missing", DEV_IN_PROD_MSG);
    }
    if (keyMaterialBytes(raw) < MIN_MASTER_KEY_BYTES) {
      throw new VaultError("master_key_missing", WEAK_MSG);
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

/**
 * The callback form, not `scryptSync`. At N=16384 the sync call blocks the
 * event loop for 60–90 ms, so a handful of concurrent saves stalls every other
 * request on this single-process server; the async form runs on the libuv
 * threadpool and leaves the loop free.
 */
function scryptAsync(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

function deriveKey(salt: Buffer): Promise<Buffer> {
  const memoKey = salt.toString("hex");
  const memo = derivedKeys.get(memoKey);
  if (memo) return memo;
  // getMasterKey() throws synchronously on a bad configuration; that is
  // deliberate, so a misconfigured process fails as itself rather than as a
  // rejected derivation.
  const derived = scryptAsync(getMasterKey(), salt);
  // A failed derivation must not be memoised as the answer for this salt.
  void derived.catch(() => derivedKeys.delete(memoKey));
  if (derivedKeys.size >= DERIVED_KEY_CACHE_MAX) {
    const oldest = derivedKeys.keys().next().value;
    if (oldest !== undefined) derivedKeys.delete(oldest);
  }
  derivedKeys.set(memoKey, derived);
  return derived;
}

/** Encrypts one API key under a fresh random salt + iv. */
export async function encryptApiKey(plaintext: string): Promise<SealedKey> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  // getAuthTag is only valid after final().
  return { ciphertext, iv, tag: cipher.getAuthTag(), salt, last4: plaintext.slice(-4) };
}

/** Decrypts. Throws VaultError("auth_tag") on tamper or wrong master key. */
export async function decryptApiKey(
  sealed: Omit<SealedKey, "last4">,
): Promise<string> {
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
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(salt), iv);
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
