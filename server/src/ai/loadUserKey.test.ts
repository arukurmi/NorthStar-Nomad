import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { requireAuth, signToken } from "../auth/tokens.js";
import { saveKey } from "./keystore.js";
import { loadUserKey, type AiRequest } from "./loadUserKey.js";
import { resetProviders, useFakeProviders } from "./registry.js";

const app = createApp();

const ANTHROPIC_KEY = "sk-ant-api03-middleware-fixture-0123456789";
const OPENAI_KEY = "sk-middleware-fixture-openai-0123456789";

/**
 * A throwaway probe standing in for an F1–F4 feature route. It reports which
 * provider was selected and how long the key is — never the key itself, which
 * is the whole invariant this middleware exists to protect.
 */
const probe = express();
probe.use(express.json());
probe.use("/probe", requireAuth, loadUserKey);
probe.all("/probe", async (req: AiRequest, res) => {
  const ai = req.ai;
  if (!ai) {
    res.status(500).json({ error: "loadUserKey did not populate req.ai" });
    return;
  }
  // Hand the plaintext to the adapter, exactly as a feature route would. The
  // fake records it, so a test can assert on it without a response body.
  await ai.provider.validate(ai.apiKey, ai.model);
  res.json({ providerId: ai.providerId, model: ai.model, keyLength: ai.apiKey.length });
});

function makeUser(email: string): { userId: number; token: string } {
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Middleware Nomad", email, "not-a-real-hash");
  const userId = Number(info.lastInsertRowid);
  return { userId, token: signToken(userId) };
}

async function addKey(
  userId: number,
  provider: "anthropic" | "gemini" | "openai",
  apiKey: string,
  validatedAt: string,
  preferred = false,
): Promise<void> {
  await saveKey({
    userId,
    provider,
    apiKey,
    model: `${provider}-model-1`,
    validatedAt,
    preferred,
  });
}

afterEach(() => {
  resetProviders();
});

describe("loadUserKey", () => {
  it("428 no_key when the user has configured nothing", async () => {
    const { token } = makeUser("mw-none@nomad.test");
    const res = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("no_key");
    expect(res.body.error).toBe("add an AI key in your profile to use this");
  });

  it("selects the explicitly requested provider from the body", async () => {
    const { userId, token } = makeUser("mw-body@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);
    await addKey(userId, "openai", OPENAI_KEY, "2026-08-01T10:00:00.000Z");

    const res = await request(probe)
      .post("/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "openai" });

    // Beats both the stored preference and the recency fallback.
    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe("openai");
    expect(res.body.model).toBe("openai-model-1");
  });

  it("selects the explicitly requested provider from the query string", async () => {
    const { userId, token } = makeUser("mw-query@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);
    await addKey(userId, "openai", OPENAI_KEY, "2026-08-01T10:00:00.000Z");

    const res = await request(probe)
      .get("/probe?provider=openai")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe("openai");
  });

  it("428 no_key naming the provider when an explicit one is not configured", async () => {
    const { userId, token } = makeUser("mw-named@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);

    const res = await request(probe)
      .post("/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "openai" });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("no_key");
    expect(res.body.error).toContain("OpenAI");
    expect(res.body.provider).toBe("openai");
  });

  it("does not silently fall back when an explicit provider is unavailable", async () => {
    const fakes = useFakeProviders();
    const { userId, token } = makeUser("mw-no-fallback@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);

    const res = await request(probe)
      .post("/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "gemini" });

    // The user asked for a specific vendor. Quietly using a different one
    // would spend their Anthropic credit on a request they aimed at Gemini.
    expect(res.status).toBe(428);
    expect(res.body.providerId).toBeUndefined();
    expect(fakes.anthropic.calls).toHaveLength(0);
    expect(fakes.gemini.calls).toHaveLength(0);
  });

  it("400 bad_request when an explicit provider is present but not a provider id", async () => {
    const fakes = useFakeProviders();
    const { userId, token } = makeUser("mw-typo@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);

    // `?provider=OpenAI` — a capitalisation typo. Treating it as "no
    // preference" served the request from Anthropic instead and billed a key
    // the caller never named.
    const query = await request(probe)
      .get("/probe?provider=OpenAI")
      .set("Authorization", `Bearer ${token}`);
    expect(query.status).toBe(400);
    expect(query.body.code).toBe("bad_request");
    expect(query.body.error).toContain("anthropic, gemini, openai");

    const body = await request(probe)
      .post("/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "claude" });
    expect(body.status).toBe(400);
    expect(body.body.code).toBe("bad_request");

    // An empty value is present, not absent, so it is also a mistake.
    const empty = await request(probe)
      .get("/probe?provider=")
      .set("Authorization", `Bearer ${token}`);
    expect(empty.status).toBe(400);

    // No key was decrypted and no vendor was called for any of the three.
    expect(fakes.anthropic.calls).toHaveLength(0);
    expect(fakes.openai.calls).toHaveLength(0);
    expect(fakes.gemini.calls).toHaveLength(0);
  });

  it("selects the stored preference when no explicit provider is given", async () => {
    const { userId, token } = makeUser("mw-pref@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-01T10:00:00.000Z", true);
    // Validated far more recently, so recency alone would pick openai.
    await addKey(userId, "openai", OPENAI_KEY, "2026-08-20T10:00:00.000Z");

    const res = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe("anthropic");
  });

  it("selects the most recently validated key when no preference is stored", async () => {
    const { userId, token } = makeUser("mw-recent@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-01T10:00:00.000Z");
    await addKey(userId, "openai", OPENAI_KEY, "2026-08-20T10:00:00.000Z");
    db.prepare("DELETE FROM ai_prefs WHERE user_id = ?").run(userId);

    const res = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe("openai");
  });

  it("hands the decrypted plaintext key to the provider adapter", async () => {
    const fakes = useFakeProviders();
    const { userId, token } = makeUser("mw-plaintext@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);

    const res = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Asserted on the adapter's own record, not on a response body — the key
    // must reach the vendor and nowhere else.
    expect(fakes.anthropic.calls).toHaveLength(1);
    expect(fakes.anthropic.calls[0].apiKey).toBe(ANTHROPIC_KEY);
    expect(res.body.keyLength).toBe(ANTHROPIC_KEY.length);
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY.slice(8, 24));
  });

  it("502 provider_error when the stored ciphertext has been tampered with", async () => {
    const { userId, token } = makeUser("mw-tampered@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);
    const row = db
      .prepare("SELECT ciphertext FROM ai_keys WHERE user_id = ?")
      .get(userId) as { ciphertext: Buffer };
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] ^= 0xff;
    db.prepare("UPDATE ai_keys SET ciphertext = ? WHERE user_id = ?").run(
      tampered,
      userId,
    );

    const res = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);

    // 502, not 401: a storage fault must not clear the user's session.
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("provider_error");
    expect(res.body.error).toContain("remove it and add it again");
  });

  it("runs after requireAuth and 401s without a token", async () => {
    const res = await request(probe).get("/probe");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
    // Not a 428 — the middleware never ran, so it never looked for a key.
    expect(res.body.code).not.toBe("no_key");
  });
});

describe("PUT /api/ai/keys/preferred", () => {
  it("PUT /api/ai/keys/preferred switches the default and returns the full list", async () => {
    const { userId, token } = makeUser("pref-switch@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);
    await addKey(userId, "openai", OPENAI_KEY, "2026-08-01T10:00:00.000Z");

    const res = await request(app)
      .put("/api/ai/keys/preferred")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "openai" });

    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(2);
    const byProvider = Object.fromEntries(
      res.body.keys.map((k: { provider: string; preferred: boolean }) => [
        k.provider,
        k.preferred,
      ]),
    );
    expect(byProvider).toEqual({ anthropic: false, openai: true });

    // And the middleware now agrees.
    const probed = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);
    expect(probed.body.providerId).toBe("openai");
  });

  it("PUT /api/ai/keys/preferred 404s for an unconfigured provider", async () => {
    const { userId, token } = makeUser("pref-missing@nomad.test");
    await addKey(userId, "anthropic", ANTHROPIC_KEY, "2026-08-20T10:00:00.000Z", true);

    const res = await request(app)
      .put("/api/ai/keys/preferred")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "gemini" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");

    // Unchanged — a failed switch does not clear the existing preference.
    const probed = await request(probe)
      .get("/probe")
      .set("Authorization", `Bearer ${token}`);
    expect(probed.body.providerId).toBe("anthropic");

    const bogus = await request(app)
      .put("/api/ai/keys/preferred")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "skynet" });
    expect(bogus.status).toBe(400);
    expect(bogus.body.code).toBe("bad_request");
  });
});
