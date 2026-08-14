import { describe, it, expect, afterEach, vi } from "vitest";
import type { Response } from "express";
import {
  AI_ERROR_STATUS,
  AiError,
  sendAiError,
  type AiErrorCode,
} from "./provider.js";
import { requestJson } from "./http.js";

const ALL_CODES = Object.keys(AI_ERROR_STATUS) as AiErrorCode[];

/**
 * The three Response methods sendAiError touches, recording what it did. Small
 * enough to be obvious, which is why this is not a supertest round trip.
 */
function fakeRes() {
  const sent = {
    status: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    set(name: string, value: string) {
      sent.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiError taxonomy", () => {
  it("maps every AiErrorCode to its documented HTTP status", () => {
    expect(AI_ERROR_STATUS).toEqual({
      no_key: 428,
      invalid_key: 401,
      insufficient_credit: 402,
      rate_limited: 429,
      provider_error: 502,
      bad_output: 502,
    });
    // The instance carries the same status, so no route has to look it up.
    for (const code of ALL_CODES) {
      expect(new AiError(code, "boom").status).toBe(AI_ERROR_STATUS[code]);
    }
  });

  it("AiError.toJSON exposes error, code, provider, retryAfter and nothing else", () => {
    const full = new AiError("rate_limited", "slow down", {
      provider: "anthropic",
      retryAfter: 30,
    });
    expect(full.toJSON()).toEqual({
      error: "slow down",
      code: "rate_limited",
      provider: "anthropic",
      retryAfter: 30,
    });
    expect(Object.keys(full.toJSON()).sort()).toEqual([
      "code",
      "error",
      "provider",
      "retryAfter",
    ]);

    // The optional fields are omitted, not emitted as undefined or null.
    const bare = new AiError("bad_output", "unparseable");
    expect(bare.toJSON()).toEqual({ error: "unparseable", code: "bad_output" });
    expect(Object.keys(bare.toJSON())).toEqual(["error", "code"]);
  });

  it("AiError.toJSON never includes cause or stack", () => {
    const CANARY = "sk-ant-api03-LEAKCANARY-7f3a9c2e5b1d8046a2c9";
    const err = new AiError("provider_error", "upstream refused", {
      cause: new Error(`request failed with x-api-key: ${CANARY}`),
    });
    const wire = JSON.stringify(err.toJSON());
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain("sk-ant-");
    expect(wire).not.toContain("stack");
    expect(wire).not.toContain("cause");
    // Serialising the error itself goes through toJSON, so the same holds there.
    expect(JSON.stringify(err)).not.toContain(CANARY);
  });

  it("AiError.from wraps an unknown throwable as provider_error", () => {
    const wrapped = AiError.from(new TypeError("fetch failed for sk-ant-secret"));
    expect(wrapped).toBeInstanceOf(AiError);
    expect(wrapped.code).toBe("provider_error");
    expect(wrapped.status).toBe(502);
    // Scrubbed: an arbitrary throwable's message is never trusted on the wire.
    expect(wrapped.message).not.toContain("sk-ant-secret");
    expect(wrapped.cause).toBeInstanceOf(TypeError);

    expect(AiError.from("a bare string").code).toBe("provider_error");
    expect(AiError.from(undefined).code).toBe("provider_error");

    // An AiError passes through untouched — no double wrapping.
    const original = new AiError("invalid_key", "that key was rejected");
    expect(AiError.from(original)).toBe(original);
  });

  it("sendAiError sets the Retry-After header for rate_limited", () => {
    const limited = fakeRes();
    sendAiError(
      limited.res,
      new AiError("rate_limited", "too many requests", {
        provider: "openai",
        retryAfter: 20,
      }),
    );
    expect(limited.sent.status).toBe(429);
    expect(limited.sent.headers["Retry-After"]).toBe("20");
    expect(limited.sent.body).toEqual({
      error: "too many requests",
      code: "rate_limited",
      provider: "openai",
      retryAfter: 20,
    });

    // No retryAfter, no header — and an unknown throwable still gets a body.
    const plain = fakeRes();
    sendAiError(plain.res, new Error("something exploded"));
    expect(plain.sent.status).toBe(502);
    expect(plain.sent.headers["Retry-After"]).toBeUndefined();
    expect((plain.sent.body as { code: string }).code).toBe("provider_error");
  });
});

describe("requestJson", () => {
  it("requestJson converts a network failure into provider_error", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("fetch failed: ENOTFOUND")),
    );
    const err = await requestJson({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: { "x-api-key": "sk-ant-secret" },
      body: { model: "claude-sonnet-5" },
      timeoutMs: 8_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("provider_error");
    expect((err as AiError).status).toBe(502);
    expect((err as AiError).message).toContain("api.anthropic.com");
    // The headers went in; nothing about them comes back out.
    expect(JSON.stringify((err as AiError).toJSON())).not.toContain("sk-ant-");
  });

  it("requestJson converts a timeout into provider_error", async () => {
    // A fetch that only ever settles when the timeout signal aborts it, so this
    // exercises the real AbortSignal.timeout path rather than a faked rejection.
    vi.stubGlobal(
      "fetch",
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
        }),
    );
    const err = await requestJson({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro",
      method: "GET",
      headers: { "x-goog-api-key": "AIzaSecret" },
      timeoutMs: 5,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("provider_error");
    expect((err as AiError).message).toContain(
      "generativelanguage.googleapis.com",
    );
    expect(JSON.stringify((err as AiError).toJSON())).not.toContain("AIza");
  });
});
