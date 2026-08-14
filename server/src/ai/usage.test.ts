import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { db } from "../db.js";
import { signToken } from "../auth/tokens.js";
import { saveKey } from "./keystore.js";
import { recordUsage, usageSummary, type UsageEvent } from "./usage.js";

const app = createApp();

const ANTHROPIC_KEY = "sk-ant-api03-usage-fixture-0123456789abc";

function makeUser(email: string): { userId: number; token: string } {
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Usage Nomad", email, "not-a-real-hash");
  const userId = Number(info.lastInsertRowid);
  return { userId, token: signToken(userId) };
}

function event(userId: number, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    userId,
    feature: "itinerary",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 200,
    cached: false,
    ...over,
  };
}

describe("usage accounting", () => {
  it("recordUsage inserts one row per call", () => {
    const { userId } = makeUser("usage-insert@nomad.test");
    recordUsage(event(userId));
    recordUsage(event(userId));

    const rows = db
      .prepare(
        "SELECT feature, provider, model, input_tokens, output_tokens, cached FROM ai_usage WHERE user_id = ?",
      )
      .all(userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      feature: "itinerary",
      provider: "anthropic",
      model: "claude-sonnet-5",
      input_tokens: 100,
      output_tokens: 200,
      cached: 0,
    });
  });

  it("usageSummary groups by feature", () => {
    const { userId } = makeUser("usage-group@nomad.test");
    recordUsage(event(userId, { feature: "itinerary" }));
    recordUsage(event(userId, { feature: "itinerary" }));
    recordUsage(event(userId, { feature: "packing" }));

    const summary = usageSummary(userId);
    expect(summary.map((r) => r.feature)).toEqual(["itinerary", "packing"]);
    expect(summary.map((r) => r.calls)).toEqual([2, 1]);
  });

  it("usageSummary counts cached calls separately from total calls", () => {
    const { userId } = makeUser("usage-cached@nomad.test");
    recordUsage(event(userId, { cached: false }));
    recordUsage(
      event(userId, { cached: true, inputTokens: 0, outputTokens: 0 }),
    );
    recordUsage(
      event(userId, { cached: true, inputTokens: 0, outputTokens: 0 }),
    );

    const [row] = usageSummary(userId);
    // calls counts every user-visible request; cachedCalls shows how many
    // were free. That difference is what makes the saving visible.
    expect(row.calls).toBe(3);
    expect(row.cachedCalls).toBe(2);
    expect(row.inputTokens).toBe(100);
  });

  it("usageSummary sums input and output tokens", () => {
    const { userId } = makeUser("usage-tokens@nomad.test");
    recordUsage(event(userId, { inputTokens: 100, outputTokens: 200 }));
    recordUsage(event(userId, { inputTokens: 40, outputTokens: 7 }));

    const [row] = usageSummary(userId);
    expect(row.inputTokens).toBe(140);
    expect(row.outputTokens).toBe(207);
  });

  it("usageSummary returns an empty array for a user with no usage", () => {
    expect(usageSummary(makeUser("usage-empty@nomad.test").userId)).toEqual([]);
  });

  it("usageSummary is scoped to one user", () => {
    const alice = makeUser("usage-alice@nomad.test");
    const bob = makeUser("usage-bob@nomad.test");
    recordUsage(event(alice.userId, { inputTokens: 999 }));

    expect(usageSummary(bob.userId)).toEqual([]);
    expect(usageSummary(alice.userId)[0].inputTokens).toBe(999);
  });
});

describe("GET /api/ai/usage", () => {
  it("GET /api/ai/usage returns usage and totals", async () => {
    const { userId, token } = makeUser("usage-route@nomad.test");
    recordUsage(
      event(userId, { feature: "itinerary", inputTokens: 100, outputTokens: 200 }),
    );
    recordUsage(
      event(userId, {
        feature: "itinerary",
        cached: true,
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
    recordUsage(
      event(userId, { feature: "packing", inputTokens: 30, outputTokens: 40 }),
    );

    const res = await request(app)
      .get("/api/ai/usage")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual([
      {
        feature: "itinerary",
        calls: 2,
        cachedCalls: 1,
        inputTokens: 100,
        outputTokens: 200,
      },
      {
        feature: "packing",
        calls: 1,
        cachedCalls: 0,
        inputTokens: 30,
        outputTokens: 40,
      },
    ]);
    expect(res.body.totals).toEqual({
      calls: 3,
      cachedCalls: 1,
      inputTokens: 130,
      outputTokens: 240,
    });

    // A user who has made no AI calls gets an empty array, not an error.
    const fresh = makeUser("usage-route-empty@nomad.test");
    const empty = await request(app)
      .get("/api/ai/usage")
      .set("Authorization", `Bearer ${fresh.token}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      usage: [],
      totals: { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 },
    });
  });

  it("GET /api/ai/usage 401s without a token", async () => {
    const res = await request(app).get("/api/ai/usage");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });

  it("deleting a key preserves historical usage rows", async () => {
    const { userId, token } = makeUser("usage-after-delete@nomad.test");
    saveKey({
      userId,
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      model: "claude-sonnet-5",
      validatedAt: "2026-08-14T10:00:00.000Z",
      preferred: true,
    });
    recordUsage(event(userId, { inputTokens: 100, outputTokens: 200 }));

    const deleted = await request(app)
      .delete("/api/ai/keys/anthropic")
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);

    // Removing a key must not erase what it was already spent on.
    const res = await request(app)
      .get("/api/ai/usage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.usage).toHaveLength(1);
    expect(res.body.usage[0]).toMatchObject({
      feature: "itinerary",
      calls: 1,
      inputTokens: 100,
    });
  });
});
