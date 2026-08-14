import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEV_MASTER_KEY,
  VaultError,
  __resetMasterKeyForTests,
  decryptApiKey,
  encryptApiKey,
  resolveMasterKey,
  type SealedKey,
} from "./vault.js";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const ORIGINAL_MASTER_KEY = process.env.NOMAD_MASTER_KEY;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetMasterKeyForTests();
});

afterEach(() => {
  if (ORIGINAL_MASTER_KEY === undefined) {
    delete process.env.NOMAD_MASTER_KEY;
  } else {
    process.env.NOMAD_MASTER_KEY = ORIGINAL_MASTER_KEY;
  }
  __resetMasterKeyForTests();
  vi.restoreAllMocks();
});

/**
 * Runs `fn`, asserts it threw a VaultError, and returns the reason. Throwing is
 * the only acceptable outcome, so a clean return is itself a failure — that is
 * what proves there is no "partial decrypt" branch handing back plaintext.
 */
function reasonOf(fn: () => unknown): string {
  let returned: unknown;
  try {
    returned = fn();
  } catch (err) {
    if (err instanceof VaultError) return err.reason;
    throw err;
  }
  throw new Error(`expected a VaultError, got a value instead: ${String(returned)}`);
}

describe("vault crypto", () => {
  it("round-trips an api key through encrypt and decrypt", () => {
    const sealed = encryptApiKey(SECRET);
    expect(decryptApiKey(sealed)).toBe(SECRET);
  });

  it("produces a fresh salt and iv on every encrypt of the same plaintext", () => {
    const a = encryptApiKey(SECRET);
    const b = encryptApiKey(SECRET);
    expect(a.salt.length).toBe(16);
    expect(a.iv.length).toBe(12);
    expect(a.tag.length).toBe(16);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("produces different ciphertext for the same plaintext twice", () => {
    const a = encryptApiKey(SECRET);
    const b = encryptApiKey(SECRET);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // Both still open — the difference is the salt and iv, not the content.
    expect(decryptApiKey(a)).toBe(SECRET);
    expect(decryptApiKey(b)).toBe(SECRET);
  });

  it("stores last4 as the final four characters of the plaintext", () => {
    const sealed = encryptApiKey(SECRET);
    expect(sealed.last4).toBe(SECRET.slice(-4));
    expect(sealed.last4).toHaveLength(4);
    // Not the prefix: sk-ant- identifies nothing, it is shared by every key.
    expect(sealed.last4).not.toBe(SECRET.slice(0, 4));
  });

  it("ciphertext bytes contain no substring of the plaintext", () => {
    const sealed = encryptApiKey(SECRET);
    for (const encoding of ["utf8", "latin1", "ascii"] as const) {
      const bytes = sealed.ciphertext.toString(encoding);
      expect(bytes).not.toContain(SECRET);
      expect(bytes).not.toContain(SECRET.slice(8, 24));
      expect(bytes).not.toContain("sk-ant-");
    }
  });

  it("fails the GCM auth tag when the ciphertext is modified", () => {
    const sealed = encryptApiKey(SECRET);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => decryptApiKey(sealed)).toThrow(VaultError);
    expect(() => decryptApiKey(sealed)).toThrow(/auth/i);
    expect(reasonOf(() => decryptApiKey(sealed))).toBe("auth_tag");
  });

  it("fails the GCM auth tag when the tag is modified", () => {
    const sealed = encryptApiKey(SECRET);
    sealed.tag[0] ^= 0xff;
    expect(reasonOf(() => decryptApiKey(sealed))).toBe("auth_tag");
  });

  it("fails the GCM auth tag when the salt is modified", () => {
    const sealed = encryptApiKey(SECRET);
    // A wrong salt derives a wrong key, which lands on the same failure path.
    sealed.salt[0] ^= 0xff;
    expect(reasonOf(() => decryptApiKey(sealed))).toBe("auth_tag");
  });

  it("fails the GCM auth tag when decrypting with a different master key", () => {
    process.env.NOMAD_MASTER_KEY = "master-key-number-one-0123456789abcdef";
    __resetMasterKeyForTests();
    const sealed = encryptApiKey(SECRET);
    expect(decryptApiKey(sealed)).toBe(SECRET);

    process.env.NOMAD_MASTER_KEY = "master-key-number-two-0123456789abcdef";
    __resetMasterKeyForTests();
    expect(() => decryptApiKey(sealed)).toThrow(VaultError);
    expect(reasonOf(() => decryptApiKey(sealed))).toBe("auth_tag");
  });

  it('throws VaultError("malformed") on a wrong-length iv', () => {
    const sealed = encryptApiKey(SECRET);
    const shortIv: Omit<SealedKey, "last4"> = {
      ...sealed,
      iv: sealed.iv.subarray(0, 11),
    };
    expect(reasonOf(() => decryptApiKey(shortIv))).toBe("malformed");

    // The same structural guard covers the tag and the salt.
    expect(
      reasonOf(() => decryptApiKey({ ...sealed, tag: sealed.tag.subarray(0, 8) })),
    ).toBe("malformed");
    expect(
      reasonOf(() => decryptApiKey({ ...sealed, salt: sealed.salt.subarray(0, 4) })),
    ).toBe("malformed");
  });
});

describe("master key resolution", () => {
  it("falls back to the dev master key outside production and warns once", () => {
    const first = resolveMasterKey({ NODE_ENV: "test" });
    const second = resolveMasterKey({});
    expect(first.toString("utf8")).toBe(DEV_MASTER_KEY);
    expect(second.toString("utf8")).toBe(DEV_MASTER_KEY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("NOMAD_MASTER_KEY");

    // An explicit key outside production is used as-is, with no warning.
    const explicit = resolveMasterKey({ NOMAD_MASTER_KEY: "a-dev-master-key" });
    expect(explicit.toString("utf8")).toBe("a-dev-master-key");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws VaultError("master_key_missing") when NODE_ENV=production and the var is unset', () => {
    expect(reasonOf(() => resolveMasterKey({ NODE_ENV: "production" }))).toBe(
      "master_key_missing",
    );
    expect(
      reasonOf(() =>
        resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: "" }),
      ),
    ).toBe("master_key_missing");
    // Whitespace is trimmed first, so a blank-looking value is still missing.
    expect(
      reasonOf(() =>
        resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: "   " }),
      ),
    ).toBe("master_key_missing");
    expect(() => resolveMasterKey({ NODE_ENV: "production" })).toThrow(
      /NOMAD_MASTER_KEY/,
    );
  });

  it("throws when the production master key is shorter than 32 characters", () => {
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: "a".repeat(31),
        }),
      ),
    ).toBe("master_key_missing");
    // 32 is the floor, not the first rejected length.
    const ok = resolveMasterKey({
      NODE_ENV: "production",
      NOMAD_MASTER_KEY: "a".repeat(32),
    });
    expect(ok.toString("utf8")).toBe("a".repeat(32));
  });

  it("throws when production is configured with the built-in dev key", () => {
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: DEV_MASTER_KEY,
        }),
      ),
    ).toBe("master_key_missing");
    // Copied out of a .env with stray whitespace: still the dev key.
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: `  ${DEV_MASTER_KEY}\n`,
        }),
      ),
    ).toBe("master_key_missing");
  });
});
