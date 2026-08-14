import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  DEV_MASTER_KEY,
  VaultError,
  __resetMasterKeyForTests,
  decryptApiKey,
  encryptApiKey,
  looksDeployed,
  resolveMasterKey,
  type KeyOwner,
  type SealedKey,
} from "./vault.js";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
/** Every blob is sealed to a (user_id, provider); this is the fixture's. */
const OWNER: KeyOwner = { userId: 42, provider: "anthropic" };
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

/** The async twin of `reasonOf`, for the promise-returning seal/open pair. */
async function reasonOfAsync(fn: () => Promise<unknown>): Promise<string> {
  let returned: unknown;
  try {
    returned = await fn();
  } catch (err) {
    if (err instanceof VaultError) return err.reason;
    throw err;
  }
  throw new Error(`expected a VaultError, got a value instead: ${String(returned)}`);
}

describe("vault crypto", () => {
  it("round-trips an api key through encrypt and decrypt", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    await expect(decryptApiKey(sealed, OWNER)).resolves.toBe(SECRET);
  });

  it("derives off the event loop", async () => {
    // scryptSync at N=16384 blocks the loop for 60–90 ms per call. The async
    // form must let a timer that was queued first still fire first.
    __resetMasterKeyForTests();
    let timerFired = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 1);
    });
    const sealed = await encryptApiKey(SECRET, OWNER);
    await timer;
    expect(timerFired).toBe(true);
    await expect(decryptApiKey(sealed, OWNER)).resolves.toBe(SECRET);
  });

  it("produces a fresh salt and iv on every encrypt of the same plaintext", async () => {
    const a = await encryptApiKey(SECRET, OWNER);
    const b = await encryptApiKey(SECRET, OWNER);
    expect(a.salt.length).toBe(16);
    expect(a.iv.length).toBe(12);
    expect(a.tag.length).toBe(16);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("produces different ciphertext for the same plaintext twice", async () => {
    const a = await encryptApiKey(SECRET, OWNER);
    const b = await encryptApiKey(SECRET, OWNER);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // Both still open — the difference is the salt and iv, not the content.
    await expect(decryptApiKey(a, OWNER)).resolves.toBe(SECRET);
    await expect(decryptApiKey(b, OWNER)).resolves.toBe(SECRET);
  });

  it("round-trips concurrent encrypts sharing one salt cache", async () => {
    const sealed = await Promise.all([
      encryptApiKey(SECRET, OWNER),
      encryptApiKey(`${SECRET}-two`, OWNER),
      encryptApiKey(`${SECRET}-three`, OWNER),
    ]);
    await expect(Promise.all(sealed.map((one) => decryptApiKey(one, OWNER)))).resolves.toEqual([
      SECRET,
      `${SECRET}-two`,
      `${SECRET}-three`,
    ]);
  });

  it("stores last4 as the final four characters of the plaintext", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    expect(sealed.last4).toBe(SECRET.slice(-4));
    expect(sealed.last4).toHaveLength(4);
    // Not the prefix: sk-ant- identifies nothing, it is shared by every key.
    expect(sealed.last4).not.toBe(SECRET.slice(0, 4));
  });

  it("ciphertext bytes contain no substring of the plaintext", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    for (const encoding of ["utf8", "latin1", "ascii"] as const) {
      const bytes = sealed.ciphertext.toString(encoding);
      expect(bytes).not.toContain(SECRET);
      expect(bytes).not.toContain(SECRET.slice(8, 24));
      expect(bytes).not.toContain("sk-ant-");
    }
  });

  it("fails the GCM auth tag when the ciphertext is modified", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    sealed.ciphertext[0] ^= 0xff;
    await expect(decryptApiKey(sealed, OWNER)).rejects.toThrow(VaultError);
    await expect(decryptApiKey(sealed, OWNER)).rejects.toThrow(/auth/i);
    await expect(reasonOfAsync(() => decryptApiKey(sealed, OWNER))).resolves.toBe(
      "auth_tag",
    );
  });

  it("fails the GCM auth tag when the tag is modified", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    sealed.tag[0] ^= 0xff;
    await expect(reasonOfAsync(() => decryptApiKey(sealed, OWNER))).resolves.toBe(
      "auth_tag",
    );
  });

  it("fails the GCM auth tag when the salt is modified", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    // A wrong salt derives a wrong key, which lands on the same failure path.
    sealed.salt[0] ^= 0xff;
    await expect(reasonOfAsync(() => decryptApiKey(sealed, OWNER))).resolves.toBe(
      "auth_tag",
    );
  });

  it("fails the GCM auth tag when decrypting with a different master key", async () => {
    process.env.NOMAD_MASTER_KEY = "master-key-number-one-0123456789abcdef";
    __resetMasterKeyForTests();
    const sealed = await encryptApiKey(SECRET, OWNER);
    await expect(decryptApiKey(sealed, OWNER)).resolves.toBe(SECRET);

    process.env.NOMAD_MASTER_KEY = "master-key-number-two-0123456789abcdef";
    __resetMasterKeyForTests();
    await expect(decryptApiKey(sealed, OWNER)).rejects.toThrow(VaultError);
    await expect(reasonOfAsync(() => decryptApiKey(sealed, OWNER))).resolves.toBe(
      "auth_tag",
    );
  });

  it("opens only under the owner it was sealed for", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    await expect(decryptApiKey(sealed, OWNER)).resolves.toBe(SECRET);
    // A copy of the owner, not the same object: the binding is by value.
    await expect(
      decryptApiKey(sealed, { userId: 42, provider: "anthropic" }),
    ).resolves.toBe(SECRET);
  });

  it("fails the auth tag when the userId differs", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    await expect(
      reasonOfAsync(() => decryptApiKey(sealed, { ...OWNER, userId: 43 })),
    ).resolves.toBe("auth_tag");
    // Including the ids either side, so this is not an off-by-one artefact.
    await expect(
      reasonOfAsync(() => decryptApiKey(sealed, { ...OWNER, userId: 41 })),
    ).resolves.toBe("auth_tag");
    await expect(
      reasonOfAsync(() => decryptApiKey(sealed, { ...OWNER, userId: 4 })),
    ).resolves.toBe("auth_tag");
  });

  it("fails the auth tag when the provider differs", async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    for (const provider of ["openai", "gemini"] as const) {
      await expect(
        reasonOfAsync(() => decryptApiKey(sealed, { ...OWNER, provider })),
      ).resolves.toBe("auth_tag");
    }
  });

  it("cannot be transplanted between two owners with the same salt", async () => {
    // The strongest form of the attack: the derived key is identical, because
    // the salt is reused, so only the AAD stands between B and A's key.
    const alice = await encryptApiKey(SECRET, { userId: 1, provider: "openai" });
    const bob = await encryptApiKey("sk-bob-key-0000", {
      userId: 2,
      provider: "openai",
    });
    const transplanted = { ...bob, salt: alice.salt, iv: alice.iv, ciphertext: alice.ciphertext, tag: alice.tag };

    // Bob's row now holds Alice's bytes verbatim. It does not open for Bob.
    await expect(
      reasonOfAsync(() =>
        decryptApiKey(transplanted, { userId: 2, provider: "openai" }),
      ),
    ).resolves.toBe("auth_tag");
    // And still opens for Alice, so nothing else was broken.
    await expect(
      decryptApiKey(transplanted, { userId: 1, provider: "openai" }),
    ).resolves.toBe(SECRET);
  });

  it('throws VaultError("malformed") on a wrong-length iv', async () => {
    const sealed = await encryptApiKey(SECRET, OWNER);
    const shortIv: Omit<SealedKey, "last4"> = {
      ...sealed,
      iv: sealed.iv.subarray(0, 11),
    };
    await expect(reasonOfAsync(() => decryptApiKey(shortIv, OWNER))).resolves.toBe(
      "malformed",
    );

    // The same structural guard covers the tag and the salt.
    await expect(
      reasonOfAsync(() =>
        decryptApiKey({ ...sealed, tag: sealed.tag.subarray(0, 8) }, OWNER),
      ),
    ).resolves.toBe("malformed");
    await expect(
      reasonOfAsync(() =>
        decryptApiKey({ ...sealed, salt: sealed.salt.subarray(0, 4) }, OWNER),
      ),
    ).resolves.toBe("malformed");
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

  it("measures the production master key in decoded bytes, not characters", () => {
    // 32 characters of one repeated symbol: the old character-count floor
    // accepted this, and it carries a single byte of entropy.
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: "a".repeat(32),
        }),
      ),
    ).toBe("master_key_missing");
    expect(() =>
      resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: "a".repeat(32) }),
    ).toThrow(/bytes of key material/);

    // A passphrase long enough to look strong but not carrying 32 bytes.
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: "correct horse battery staple xyz!",
        }),
      ),
    ).toBe("master_key_missing");
  });

  it("accepts base64 and hex master keys carrying 32 bytes", () => {
    // What `openssl rand -base64 48` produces: 64 characters, 48 bytes.
    const base64 = randomBytes(48).toString("base64");
    expect(
      resolveMasterKey({
        NODE_ENV: "production",
        NOMAD_MASTER_KEY: base64,
      }).toString("utf8"),
    ).toBe(base64);

    // Exactly at the floor: base64 of 32 bytes.
    const atFloor = randomBytes(32).toString("base64");
    expect(() =>
      resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: atFloor }),
    ).not.toThrow();

    // Hex is read as hex too — 64 hex characters are 32 bytes.
    const hex = randomBytes(32).toString("hex");
    expect(() =>
      resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: hex }),
    ).not.toThrow();

    // One byte short, as hex.
    expect(
      reasonOf(() =>
        resolveMasterKey({
          NODE_ENV: "production",
          NOMAD_MASTER_KEY: randomBytes(20).toString("hex"),
        }),
      ),
    ).toBe("master_key_missing");
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

  it("rejects a master key that merely contains the dev key", () => {
    // Exact-match rejection let one appended character through, and the result
    // is still a public constant plus a character.
    for (const raw of [
      `${DEV_MASTER_KEY}!`,
      `x${DEV_MASTER_KEY}`,
      `prefix-${DEV_MASTER_KEY}-suffix`,
      DEV_MASTER_KEY.toUpperCase(),
    ]) {
      expect(
        reasonOf(() =>
          resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: raw }),
        ),
      ).toBe("master_key_missing");
      expect(() =>
        resolveMasterKey({ NODE_ENV: "production", NOMAD_MASTER_KEY: raw }),
      ).toThrow(/built-in development key/);
    }
  });
});

describe("deployed-host detection", () => {
  it("refuses the dev master key when a platform marker is present", () => {
    // The production failure this closes: a host that never exported NODE_ENV
    // would otherwise take the dev branch and seal real keys with a constant
    // that is public in git.
    for (const marker of [
      "RENDER",
      "K_SERVICE",
      "DYNO",
      "FLY_APP_NAME",
      "VERCEL",
      "AWS_EXECUTION_ENV",
      "KUBERNETES_SERVICE_HOST",
      "WEBSITE_INSTANCE_ID",
    ]) {
      expect(looksDeployed({ [marker]: "true" })).toBe(true);
      expect(reasonOf(() => resolveMasterKey({ [marker]: "true" }))).toBe(
        "master_key_missing",
      );
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("holds a deployed host to the production strength checks", () => {
    expect(
      reasonOf(() =>
        resolveMasterKey({ RENDER: "true", NOMAD_MASTER_KEY: "a".repeat(32) }),
      ),
    ).toBe("master_key_missing");
    expect(
      reasonOf(() =>
        resolveMasterKey({ RENDER: "true", NOMAD_MASTER_KEY: DEV_MASTER_KEY }),
      ),
    ).toBe("master_key_missing");
    // A real key on a deployed host is fine.
    const good = randomBytes(48).toString("base64");
    expect(
      resolveMasterKey({ RENDER: "true", NOMAD_MASTER_KEY: good }).toString("utf8"),
    ).toBe(good);
  });

  it("does not treat a laptop or a CI runner as deployed", () => {
    expect(looksDeployed({})).toBe(false);
    // CI is not a deployed host: its tests need the dev fallback to work.
    expect(looksDeployed({ CI: "true", NODE_ENV: "test" })).toBe(false);
    // An empty marker is not a marker.
    expect(looksDeployed({ RENDER: "" })).toBe(false);
    expect(resolveMasterKey({ CI: "true" }).toString("utf8")).toBe(DEV_MASTER_KEY);
  });
});
