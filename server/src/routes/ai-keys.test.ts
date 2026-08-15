import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Response as SupertestResponse } from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { requireAuth } from "../auth/tokens.js";
import { loadUserKey, type AiRequest } from "../ai/loadUserKey.js";
import { AiError } from "../ai/provider.js";
import { FAKE_MODEL } from "../ai/providers/fake.js";
import { resetProviders, useFakeProviders } from "../ai/registry.js";
import { __resetSaveLimitForTests } from "./ai-keys.js";

const app = createApp();

const ANTHROPIC_KEY = "sk-ant-api03-route-fixture-0123456789abcd";
const OPENAI_KEY = "sk-route-fixture-openai-0123456789abcd";

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Keys Nomad", email, password: "wanderlust1" });
  return res.body.token as string;
}

function userIdFor(email: string): number {
  return (
    db.prepare("SELECT id FROM users WHERE email = ?").get(email) as {
      id: number;
    }
  ).id;
}

/**
 * Stands in for an F1–F4 feature route so the leak tests cover the read side
 * of the vault too: `loadUserKey` decrypts the stored key and hands the
 * plaintext to an adapter. It reports the key's *length*, never the key.
 */
const logProbe = express();
logProbe.use("/probe", requireAuth, loadUserKey);
logProbe.get("/probe", (req: AiRequest, res) => {
  const ai = req.ai;
  if (!ai) {
    res.status(500).json({ error: "loadUserKey did not populate req.ai" });
    return;
  }
  void ai.provider
    .validate(ai.apiKey, ai.model)
    .then(() => {
      res.json({ providerId: ai.providerId, keyLength: ai.apiKey.length });
    })
    .catch(() => {
      res.status(500).json({ error: "probe validate failed" });
    });
});

function save(token: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/ai/keys")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

afterEach(() => {
  resetProviders();
  __resetSaveLimitForTests();
});

describe("POST /api/ai/keys", () => {
  it("saves a key and returns provider, last4, model and validatedAt", async () => {
    const token = await register("save-route@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
    });

    expect(res.status).toBe(200);
    expect(res.body.key).toEqual({
      provider: "anthropic",
      last4: ANTHROPIC_KEY.slice(-4),
      model: "claude-sonnet-5",
      validatedAt: expect.any(String),
      preferred: true,
    });
  });

  it("defaults the model to the provider default when omitted", async () => {
    const token = await register("default-model@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body.key.model).toBe(FAKE_MODEL);
  });

  it("accepts an explicit model override", async () => {
    const token = await register("model-override@nomad.test");
    const res = await save(token, {
      provider: "openai",
      apiKey: OPENAI_KEY,
      model: "gpt-5-mini",
    });

    expect(res.status).toBe(200);
    expect(res.body.key.model).toBe("gpt-5-mini");
  });

  it("401s every /api/ai/keys route without a bearer token", async () => {
    expect(
      (await request(app).post("/api/ai/keys").send({ provider: "anthropic" }))
        .status,
    ).toBe(401);
    expect((await request(app).get("/api/ai/keys")).status).toBe(401);
    expect((await request(app).delete("/api/ai/keys/anthropic")).status).toBe(
      401,
    );
  });

  it('returns code "unauthenticated" rather than "invalid_key" for a missing token', async () => {
    const res = await request(app).get("/api/ai/keys");
    expect(res.status).toBe(401);
    // Both 401s are real; the client must tell "your session is gone" from
    // "that API key was rejected" without parsing a message string.
    expect(res.body.code).toBe("unauthenticated");
    expect(res.body.code).not.toBe("invalid_key");
  });

  it("400s an unknown provider", async () => {
    const token = await register("bad-provider@nomad.test");
    const res = await save(token, {
      provider: "skynet",
      apiKey: ANTHROPIC_KEY,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
  });

  it("400s a malformed anthropic key shape", async () => {
    const token = await register("bad-shape@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: "definitely-not-an-anthropic-key",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
    expect(db.prepare("SELECT * FROM ai_keys WHERE user_id = ?").all(
      userIdFor("bad-shape@nomad.test"),
    )).toHaveLength(0);
  });

  it("400s a key containing a newline", async () => {
    const token = await register("newline-key@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: "sk-ant-api03-broken\nby-a-newline-0123456789",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");

    // A *trailing* newline, by contrast, is the console "copy" button's doing
    // and is stripped rather than rejected.
    const trailing = await save(token, {
      provider: "anthropic",
      apiKey: `${ANTHROPIC_KEY}\n`,
    });
    expect(trailing.status).toBe(200);
    expect(trailing.body.key.last4).toBe(ANTHROPIC_KEY.slice(-4));
  });

  it('401s with code "invalid_key" when the provider rejects the key', async () => {
    useFakeProviders({
      validate: { ok: false, code: "invalid_key", message: "that key was rejected" },
    });
    const token = await register("rejected-key@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_key");
    expect(res.body.provider).toBe("anthropic");
  });

  it("402s when the provider reports insufficient credit", async () => {
    useFakeProviders({
      validate: {
        ok: false,
        code: "insufficient_credit",
        message: "your credit balance is too low",
      },
    });
    const token = await register("no-credit@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("insufficient_credit");
  });

  it("429s with a Retry-After header when the provider rate limits validation", async () => {
    useFakeProviders({
      validate: {
        ok: false,
        code: "rate_limited",
        message: "too many requests",
        retryAfter: 27,
      },
    });
    const token = await register("throttled@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
    expect(res.body.retryAfter).toBe(27);
    expect(res.headers["retry-after"]).toBe("27");
  });

  it("502s when the provider is unreachable", async () => {
    useFakeProviders({
      validate: new AiError("provider_error", "could not reach anthropic"),
    });
    const token = await register("unreachable@nomad.test");
    const res = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("provider_error");
  });

  it("writes no row when validation fails", async () => {
    useFakeProviders({
      validate: { ok: false, code: "invalid_key", message: "nope" },
    });
    const token = await register("no-write@nomad.test");
    await save(token, { provider: "anthropic", apiKey: ANTHROPIC_KEY });

    const rows = db
      .prepare("SELECT * FROM ai_keys WHERE user_id = ?")
      .all(userIdFor("no-write@nomad.test"));
    expect(rows).toHaveLength(0);

    const list = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.keys).toEqual([]);
  });

  it("replaces an existing key for the same provider without creating a duplicate", async () => {
    const token = await register("replace@nomad.test");
    await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
    });
    const second = await save(token, {
      provider: "anthropic",
      apiKey: "sk-ant-api03-a-replacement-key-98765432109",
      model: "claude-haiku-5",
    });

    // An upsert, not a 409 — replacing a key is one action for the user.
    expect(second.status).toBe(200);
    expect(second.body.key.last4).toBe("2109");
    expect(second.body.key.model).toBe("claude-haiku-5");

    const list = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.keys).toHaveLength(1);
  });
});

describe("POST /api/ai/keys rate limit", () => {
  it("429s the eleventh save in an hour and names a retryAfter", async () => {
    const token = await register("rate-limit@nomad.test");

    for (let n = 0; n < 10; n += 1) {
      const res = await save(token, { provider: "anthropic", apiKey: ANTHROPIC_KEY });
      expect(res.status).toBe(200);
    }

    const blocked = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate_limited");
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retryAfter));
    // Nothing about the rejected credential comes back.
    expect(blocked.text).not.toContain(ANTHROPIC_KEY.slice(8, 24));
  });

  it("counts rejected attempts too, so it caps the validation oracle", async () => {
    const token = await register("rate-limit-oracle@nomad.test");

    // Ten probes with a key that never passes shape validation. If only
    // successful saves were counted, an attacker could test stolen keys
    // against three vendors indefinitely.
    for (let n = 0; n < 10; n += 1) {
      const res = await save(token, { provider: "anthropic", apiKey: "sk-ant-nope" });
      expect(res.status).toBe(400);
    }

    const blocked = await save(token, {
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });
    expect(blocked.status).toBe(429);
  });

  it("is scoped per account", async () => {
    const mine = await register("rate-limit-mine@nomad.test");
    const theirs = await register("rate-limit-theirs@nomad.test");
    for (let n = 0; n < 10; n += 1) {
      await save(mine, { provider: "anthropic", apiKey: ANTHROPIC_KEY });
    }
    expect((await save(mine, { provider: "anthropic", apiKey: ANTHROPIC_KEY })).status).toBe(429);
    // One noisy account does not lock everybody else out.
    expect((await save(theirs, { provider: "anthropic", apiKey: ANTHROPIC_KEY })).status).toBe(200);
  });
});

describe("GET /api/ai/keys", () => {
  it("lists an empty array for a new user", async () => {
    const token = await register("empty-list@nomad.test");
    const res = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([]);
  });

  it("keeps each user's keys private", async () => {
    const alice = await register("keys-alice@nomad.test");
    const bob = await register("keys-bob@nomad.test");
    await save(alice, { provider: "anthropic", apiKey: ANTHROPIC_KEY });

    const bobList = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${bob}`);
    expect(bobList.status).toBe(200);
    expect(bobList.body.keys).toEqual([]);

    const aliceList = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${alice}`);
    expect(aliceList.body.keys.map((k: { provider: string }) => k.provider)).toEqual(
      ["anthropic"],
    );
  });
});

describe("DELETE /api/ai/keys/:provider", () => {
  it("deletes a configured key and returns 204", async () => {
    const token = await register("delete-ok@nomad.test");
    await save(token, { provider: "anthropic", apiKey: ANTHROPIC_KEY });

    const res = await request(app)
      .delete("/api/ai/keys/anthropic")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    const list = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.keys).toEqual([]);
  });

  it("404s deleting a provider that was never configured", async () => {
    const token = await register("delete-missing@nomad.test");
    const res = await request(app)
      .delete("/api/ai/keys/gemini")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");

    // An unknown provider is a 400, not a 404 — it is a malformed request.
    const bogus = await request(app)
      .delete("/api/ai/keys/skynet")
      .set("Authorization", `Bearer ${token}`);
    expect(bogus.status).toBe(400);
    expect(bogus.body.code).toBe("bad_request");
  });

  it("404s deleting another user's key", async () => {
    const alice = await register("del-alice@nomad.test");
    const bob = await register("del-bob@nomad.test");
    await save(alice, { provider: "anthropic", apiKey: ANTHROPIC_KEY });

    const res = await request(app)
      .delete("/api/ai/keys/anthropic")
      .set("Authorization", `Bearer ${bob}`);
    // 404, never 403: an existence oracle is itself a leak.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");

    const aliceList = await request(app)
      .get("/api/ai/keys")
      .set("Authorization", `Bearer ${alice}`);
    expect(aliceList.body.keys).toHaveLength(1);
  });
});

/**
 * The point of this feature. A key the user hands us must be unreadable from
 * every surface we expose — success bodies, error bodies, headers, and the
 * database file itself.
 */
describe("key leakage", () => {
  const CANARY = "sk-ant-api03-LEAKCANARY-7f3a9c2e5b1d8046a2c9";
  /**
   * The middle slice catches a *partially* redacted leak — something like
   * `sk-…LEAKCANARY-7f3a9c2e5b1d8046a2c9` would sail past a whole-string check
   * while still handing an attacker most of the credential.
   */
  const CANARY_MIDDLE = CANARY.slice(8, 24);

  function expectNoCanary(label: string, res: SupertestResponse): void {
    const surfaces: Array<[string, string]> = [
      ["body", JSON.stringify(res.body ?? null)],
      ["text", res.text ?? ""],
      ["headers", JSON.stringify(res.headers ?? null)],
    ];
    for (const [surface, serialised] of surfaces) {
      expect(serialised, `${label} ${surface} leaked the whole key`).not.toContain(
        CANARY,
      );
      expect(
        serialised,
        `${label} ${surface} leaked part of the key`,
      ).not.toContain(CANARY_MIDDLE);
    }
  }

  it("never returns the plaintext key from any /api/ai endpoint", async () => {
    const token = await register("canary@nomad.test");
    const auth = `Bearer ${token}`;

    // 1. Save it. Asserted, so this test can never pass vacuously by failing
    //    to store the canary in the first place.
    const saved = await save(token, {
      provider: "anthropic",
      apiKey: CANARY,
      model: "claude-sonnet-5",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.key.last4).toBe(CANARY.slice(-4));
    expectNoCanary("POST /api/ai/keys", saved);

    // 2. The upsert response.
    expectNoCanary(
      "POST /api/ai/keys (upsert)",
      await save(token, { provider: "anthropic", apiKey: CANARY }),
    );

    // 3. Error bodies. First a shape rejection, then a provider rejection —
    //    the second is the dangerous one, because the route is holding the
    //    plaintext canary at the moment it writes the error.
    expectNoCanary(
      "POST /api/ai/keys (bad shape)",
      await save(token, { provider: "anthropic", apiKey: `${CANARY}$$` }),
    );
    useFakeProviders({
      validate: { ok: false, code: "invalid_key", message: "rejected" },
    });
    const rejected = await save(token, {
      provider: "anthropic",
      apiKey: CANARY,
    });
    expect(rejected.status).toBe(401);
    expectNoCanary("POST /api/ai/keys (provider rejection)", rejected);
    resetProviders();

    // 4. Every remaining /api/ai surface, plus the adjacent authed routes a
    //    leak could plausibly ride along on.
    const reads: Array<[string, SupertestResponse]> = [
      ["GET /api/ai/keys", await request(app).get("/api/ai/keys").set("Authorization", auth)],
      [
        "PUT /api/ai/keys/preferred",
        await request(app)
          .put("/api/ai/keys/preferred")
          .set("Authorization", auth)
          .send({ provider: "anthropic" }),
      ],
      ["GET /api/ai/usage", await request(app).get("/api/ai/usage").set("Authorization", auth)],
      // F2's route is the first surface that *decrypts* the canary and hands
      // the plaintext to an adapter, so it belongs in this sweep more than any
      // of the key-management routes do. Both a success and a rejection: the
      // rejection is the dangerous one, because the handler is holding the
      // plaintext at the moment it writes the error body.
      [
        "POST /api/ai/packing",
        await request(app)
          .post("/api/ai/packing")
          .set("Authorization", auth)
          .send({
            destinationId: "goa",
            start: "2026-12-25",
            end: "2026-12-27",
            mode: "flight",
          }),
      ],
      [
        "POST /api/ai/packing (bad request)",
        await request(app)
          .post("/api/ai/packing")
          .set("Authorization", auth)
          .send({ destinationId: "nowhere", start: "x", end: "y", mode: "sled" }),
      ],
      ["GET /api/auth/me", await request(app).get("/api/auth/me").set("Authorization", auth)],
      ["GET /api/trips", await request(app).get("/api/trips").set("Authorization", auth)],
      [
        "DELETE /api/ai/keys/anthropic",
        await request(app).delete("/api/ai/keys/anthropic").set("Authorization", auth),
      ],
    ];
    for (const [label, res] of reads) expectNoCanary(label, res);
  });

  it("stores no plaintext key bytes in any ai_keys column", async () => {
    const token = await register("canary-storage@nomad.test");
    const saved = await save(token, {
      provider: "anthropic",
      apiKey: CANARY,
    });
    expect(saved.status).toBe(200);

    // `SELECT *`, not a column list. Naming columns would test only the two
    // places we already know to look; a column added later — a debug field, a
    // cached header, a "hint" — is exactly where plaintext would reappear, and
    // this assertion has to see it without being edited first.
    const row = db
      .prepare("SELECT * FROM ai_keys WHERE user_id = ?")
      .get(userIdFor("canary-storage@nomad.test")) as Record<string, unknown>;

    const columns = Object.entries(row);
    expect(columns.length).toBeGreaterThan(0);
    for (const [column, value] of columns) {
      // latin1 keeps one byte to one character, so a plaintext run inside a
      // BLOB survives the conversion instead of collapsing into replacement
      // characters and hiding the leak it was meant to expose.
      const serialised =
        value instanceof Uint8Array
          ? Buffer.from(value).toString("latin1")
          : String(value ?? "");
      expect(serialised, `column ${column} leaked the whole key`).not.toContain(
        CANARY,
      );
      expect(serialised, `column ${column} leaked part of the key`).not.toContain(
        CANARY_MIDDLE,
      );
    }
    expect(row.last4).toBe(CANARY.slice(-4));
  });

  it("never writes the key to a console method, stdout or stderr", async () => {
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };
    const writeSpy = (stream: NodeJS.WriteStream) =>
      vi.spyOn(stream, "write").mockImplementation((chunk: unknown): boolean => {
        record(chunk);
        return true;
      });
    const spies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
      vi.spyOn(console, "error").mockImplementation(record),
      writeSpy(process.stdout),
      writeSpy(process.stderr),
    ];

    try {
      const token = await register("canary-logs@nomad.test");
      const auth = `Bearer ${token}`;

      const saved = await save(token, {
        provider: "anthropic",
        apiKey: CANARY,
        model: "claude-sonnet-5",
      });
      expect(saved.status).toBe(200);

      // The route is holding the plaintext at the moment it builds this error,
      // which is where a well-meaning `console.error(err)` would land.
      useFakeProviders({
        validate: { ok: false, code: "invalid_key", message: "rejected" },
      });
      const rejected = await save(token, {
        provider: "anthropic",
        apiKey: CANARY,
      });
      expect(rejected.status).toBe(401);
      resetProviders();

      // The other end of the vault: loadUserKey decrypts the stored canary and
      // hands the plaintext to an adapter, exactly as an F1–F4 route will.
      const probed = await request(logProbe)
        .get("/probe")
        .set("Authorization", auth);
      expect(probed.status).toBe(200);
      expect(probed.body.keyLength).toBe(CANARY.length);

      await request(app).get("/api/ai/keys").set("Authorization", auth);
      await request(app)
        .delete("/api/ai/keys/anthropic")
        .set("Authorization", auth);
      // Some logging defers itself with setImmediate; give it a turn to run
      // while the spies are still installed.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const logged = lines.join("\n");
    expect(logged, "a log line leaked the whole key").not.toContain(CANARY);
    expect(logged, "a log line leaked part of the key").not.toContain(
      CANARY_MIDDLE,
    );
  });
});
