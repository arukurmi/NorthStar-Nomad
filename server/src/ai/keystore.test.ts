import { describe, it, expect } from "vitest";
import { db } from "../db.js";
import { AiError } from "./provider.js";
import {
  deleteKey,
  listKeys,
  saveKey,
  selectKey,
  setPreferred,
} from "./keystore.js";

/** A real user row — ai_keys.user_id references users(id). */
function makeUser(email: string): number {
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Keystore Nomad", email, "not-a-real-hash");
  return Number(info.lastInsertRowid);
}

const ANTHROPIC_KEY = "sk-ant-api03-keystore-fixture-0123456789";
const OPENAI_KEY = "sk-keystore-fixture-openai-0123456789";
const GEMINI_KEY = "AIzaKeystoreFixtureGemini0123456789012345";

function blobs(userId: number, provider: string) {
  return db
    .prepare(
      "SELECT ciphertext, iv, tag, salt FROM ai_keys WHERE user_id = ? AND provider = ?",
    )
    .get(userId, provider) as {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
    salt: Buffer;
  };
}

describe("keystore", () => {
  it("saveKey inserts a row and returns the redacted shape", () => {
    const userId = makeUser("save@nomad.test");
    const key = saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: false,
    });

    expect(key).toEqual({
      provider: "anthropic",
      last4: ANTHROPIC_KEY.slice(-4),
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true, // first key
    });
    // The redacted shape has exactly these five fields and nothing else.
    expect(Object.keys(key).sort()).toEqual([
      "last4",
      "model",
      "preferred",
      "provider",
      "validatedAt",
    ]);
  });

  it("saveKey upserts on a second save for the same provider", () => {
    const userId = makeUser("upsert@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: false,
    });
    const second = saveKey({
      userId,
      provider: "anthropic",
      apiKey: "sk-ant-api03-a-completely-different-key-9999",
      model: "claude-haiku-5",
      validatedAt: "2026-08-15T10:00:00.000Z",
      preferred: false,
    });

    const rows = db
      .prepare("SELECT provider FROM ai_keys WHERE user_id = ?")
      .all(userId);
    expect(rows).toHaveLength(1);
    expect(second.model).toBe("claude-haiku-5");
    expect(second.last4).toBe("9999");
    // The upsert refreshes the credential, not the first-connected date.
    expect(selectKey(userId)?.apiKey).toBe(
      "sk-ant-api03-a-completely-different-key-9999",
    );
  });

  it("saveKey rotates the salt and iv on upsert", () => {
    const userId = makeUser("rotate@nomad.test");
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: false,
    });
    const before = blobs(userId, "openai");

    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-15T10:00:00.000Z",
      preferred: false,
    });
    const after = blobs(userId, "openai");

    // Same plaintext, fresh salt and iv — so the old derived key is dead.
    expect(after.salt.equals(before.salt)).toBe(false);
    expect(after.iv.equals(before.iv)).toBe(false);
    expect(after.ciphertext.equals(before.ciphertext)).toBe(false);
  });

  it("saveKey marks the first key preferred automatically", () => {
    const userId = makeUser("first-pref@nomad.test");
    const first = saveKey({
      userId,
      provider: "gemini",
      apiKey: GEMINI_KEY,
      model: "gemini-2.5-pro",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: false,
    });
    expect(first.preferred).toBe(true);

    // A second key does not steal the preference unless it asks to.
    const second = saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-15T10:00:00.000Z",
      preferred: false,
    });
    expect(second.preferred).toBe(false);
    expect(selectKey(userId)?.providerId).toBe("gemini");

    // Asking explicitly does move it.
    const third = saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-16T10:00:00.000Z",
      preferred: true,
    });
    expect(third.preferred).toBe(true);
    expect(selectKey(userId)?.providerId).toBe("anthropic");
  });

  it("listKeys returns an empty array for a user with no keys", () => {
    expect(listKeys(makeUser("empty@nomad.test"))).toEqual([]);
  });

  it("listKeys never returns ciphertext, iv, tag or salt", () => {
    const userId = makeUser("redacted@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });

    const keys = listKeys(userId);
    expect(keys).toHaveLength(1);
    for (const key of keys) {
      expect(Object.keys(key).sort()).toEqual([
        "last4",
        "model",
        "preferred",
        "provider",
        "validatedAt",
      ]);
    }
    const serialised = JSON.stringify(keys);
    expect(serialised).not.toContain(ANTHROPIC_KEY);
    expect(serialised).not.toContain(ANTHROPIC_KEY.slice(8, 24));
    expect(serialised).not.toContain("ciphertext");
    expect(serialised).not.toContain("salt");
  });

  it("listKeys is scoped to one user", () => {
    const alice = makeUser("list-alice@nomad.test");
    const bob = makeUser("list-bob@nomad.test");
    saveKey({
      userId: alice,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });

    expect(listKeys(alice).map((k) => k.provider)).toEqual(["anthropic"]);
    expect(listKeys(bob)).toEqual([]);
  });

  it("deleteKey returns false when nothing was configured", () => {
    const userId = makeUser("delete-miss@nomad.test");
    expect(deleteKey(userId, "openai")).toBe(false);
  });

  it("deleteKey clears a matching ai_prefs row in the same transaction", () => {
    const userId = makeUser("delete-pref@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-15T10:00:00.000Z",
      preferred: false,
    });

    expect(deleteKey(userId, "anthropic")).toBe(true);
    // No dangling preference to a provider the user no longer has a key for.
    const pref = db
      .prepare("SELECT provider FROM ai_prefs WHERE user_id = ?")
      .get(userId);
    expect(pref).toBeUndefined();
    // The unrelated key survives.
    expect(listKeys(userId).map((k) => k.provider)).toEqual(["openai"]);

    // Deleting a provider that is not the preferred one leaves the pref alone.
    setPreferred(userId, "openai");
    saveKey({
      userId,
      provider: "gemini",
      apiKey: GEMINI_KEY,
      model: "gemini-2.5-pro",
      validatedAt: "2026-08-16T10:00:00.000Z",
      preferred: false,
    });
    expect(deleteKey(userId, "gemini")).toBe(true);
    expect(
      (
        db
          .prepare("SELECT provider FROM ai_prefs WHERE user_id = ?")
          .get(userId) as { provider: string }
      ).provider,
    ).toBe("openai");
  });

  it("selectKey returns null for a user with no keys", () => {
    expect(selectKey(makeUser("select-empty@nomad.test"))).toBeNull();
  });

  it("selectKey honours an explicit provider argument", () => {
    const userId = makeUser("select-explicit@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-15T10:00:00.000Z",
      preferred: false,
    });

    expect(selectKey(userId, "openai")).toEqual({
      providerId: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
    });
    // An explicit provider the user has not configured does not fall through.
    expect(selectKey(userId, "gemini")).toBeNull();
  });

  it("selectKey falls back to the stored preference", () => {
    const userId = makeUser("select-pref@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: false,
    });
    // Saved later, so "most recently validated" would pick openai instead.
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-20T10:00:00.000Z",
      preferred: false,
    });
    setPreferred(userId, "anthropic");

    expect(selectKey(userId)?.providerId).toBe("anthropic");
  });

  it("selectKey falls back to the most recently validated key", () => {
    const userId = makeUser("select-recent@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-01T10:00:00.000Z",
      preferred: false,
    });
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-20T10:00:00.000Z",
      preferred: false,
    });
    // No preference at all — first-key auto-preference removed.
    db.prepare("DELETE FROM ai_prefs WHERE user_id = ?").run(userId);

    expect(selectKey(userId)?.providerId).toBe("openai");
  });

  it("selectKey ignores a stored preference whose key row was deleted", () => {
    const userId = makeUser("select-dangling@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-01T10:00:00.000Z",
      preferred: true,
    });
    saveKey({
      userId,
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5",
      validatedAt: "2026-08-20T10:00:00.000Z",
      preferred: false,
    });
    // A dangling preference, as if the transactional cleanup had not run.
    db.prepare("DELETE FROM ai_keys WHERE user_id = ? AND provider = ?").run(
      userId,
      "anthropic",
    );

    expect(selectKey(userId)?.providerId).toBe("openai");
  });

  it("selectKey throws provider_error when the stored blob will not decrypt", () => {
    const userId = makeUser("select-tampered@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });
    const row = blobs(userId, "anthropic");
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] ^= 0xff;
    db.prepare(
      "UPDATE ai_keys SET ciphertext = ? WHERE user_id = ? AND provider = ?",
    ).run(tampered, userId, "anthropic");

    let thrown: unknown;
    try {
      selectKey(userId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiError);
    expect((thrown as AiError).code).toBe("provider_error");
    expect((thrown as AiError).status).toBe(502);
    // The failure message never carries key material.
    expect((thrown as AiError).message).not.toContain(ANTHROPIC_KEY.slice(8, 24));
  });
});
