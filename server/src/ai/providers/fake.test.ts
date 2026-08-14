import { describe, it, expect, afterEach } from "vitest";
import { AiError, PROVIDER_IDS, type CompletionRequest } from "../provider.js";
import { createFakeProvider, FAKE_MODEL } from "./fake.js";
import { getProvider, resetProviders, useFakeProviders } from "../registry.js";

const SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

interface Answer {
  city: string;
}

/** Throws on anything that is not `{ city: string }` — the schema violation. */
function parseAnswer(value: unknown): Answer {
  const city = (value as { city?: unknown } | null)?.city;
  if (typeof city !== "string") throw new Error("expected a city string");
  return { city };
}

function completionOf(
  overrides: Partial<CompletionRequest<Answer>> = {},
): CompletionRequest<Answer> {
  return {
    apiKey: "sk-ant-fake-key",
    model: FAKE_MODEL,
    system: "you plan trips",
    user: "where should I go in December?",
    schema: SCHEMA as unknown as CompletionRequest<Answer>["schema"],
    schemaName: "answer",
    parse: parseAnswer,
    ...overrides,
  };
}

afterEach(() => {
  resetProviders();
});

describe("fake provider", () => {
  it("validate resolves the scripted ValidationResult", async () => {
    const fake = createFakeProvider("anthropic");
    // Unscripted: the documented default.
    expect(await fake.validate("sk-ant-fake-key")).toEqual({
      ok: true,
      model: FAKE_MODEL,
    });

    fake.script({ validate: { ok: false, code: "invalid_key", message: "nope" } });
    expect(await fake.validate("sk-ant-fake-key")).toEqual({
      ok: false,
      code: "invalid_key",
      message: "nope",
    });
  });

  it("validate rejects with the scripted AiError", async () => {
    const fake = createFakeProvider("openai");
    fake.script({
      validate: new AiError("rate_limited", "too many key checks", {
        provider: "openai",
        retryAfter: 20,
      }),
    });
    const err = await fake.validate("sk-fake-key").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("rate_limited");
    expect((err as AiError).status).toBe(429);
    expect((err as AiError).retryAfter).toBe(20);
  });

  it("complete consumes scripted completions in order", async () => {
    const fake = createFakeProvider("gemini");
    fake.script({
      completions: [{ city: "goa" }, { city: "leh" }],
      defaultPayload: { city: "fallback" },
    });
    expect((await fake.complete(completionOf())).data).toEqual({ city: "goa" });
    expect((await fake.complete(completionOf())).data).toEqual({ city: "leh" });
    // Exhausted, so it falls back to defaultPayload rather than throwing.
    expect((await fake.complete(completionOf())).data).toEqual({
      city: "fallback",
    });
  });

  it("complete runs the caller's parse function", async () => {
    const fake = createFakeProvider("anthropic");
    fake.script({ completions: [{ city: "goa", extra: "ignored" }] });
    const seen: unknown[] = [];
    const result = await fake.complete(
      completionOf({
        parse: (value: unknown) => {
          seen.push(value);
          return parseAnswer(value);
        },
      }),
    );
    // parse both ran and owned the returned shape — `extra` was dropped by it.
    expect(seen).toEqual([{ city: "goa", extra: "ignored" }]);
    expect(result.data).toEqual({ city: "goa" });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe(FAKE_MODEL);
    expect(result.retried).toBe(false);
  });

  it("complete rejects with bad_output when parse throws", async () => {
    const fake = createFakeProvider("openai");
    fake.script({ completions: [{ wrong: "shape" }] });
    const err = await fake.complete(completionOf()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    expect((err as AiError).status).toBe(502);
    expect((err as AiError).provider).toBe("openai");

    // A scripted AiError is rejected as itself, not rewrapped as bad_output.
    fake.script({ completions: [new AiError("insufficient_credit", "broke")] });
    const scripted = await fake.complete(completionOf()).catch((e: unknown) => e);
    expect((scripted as AiError).code).toBe("insufficient_credit");
  });

  it("complete returns deterministic token counts for identical input", async () => {
    const fake = createFakeProvider("anthropic");
    const payload = { city: "goa" };
    fake.script({ completions: [payload, payload] });
    const first = await fake.complete(completionOf());
    const second = await fake.complete(completionOf());

    expect(first.inputTokens).toBe(second.inputTokens);
    expect(first.outputTokens).toBe(second.outputTokens);
    // Exact numbers, so the usage tests can assert on them rather than ranges.
    const req = completionOf();
    expect(first.inputTokens).toBe(
      Math.ceil((req.system.length + req.user.length) / 4),
    );
    expect(first.outputTokens).toBe(
      Math.ceil(JSON.stringify(payload).length / 4),
    );

    // A longer prompt costs more — the count tracks the input, it is not fixed.
    fake.script({ completions: [payload] });
    const longer = await fake.complete(
      completionOf({ user: "where should I go in December? ".repeat(10) }),
    );
    expect(longer.inputTokens).toBeGreaterThan(first.inputTokens);
  });

  it("records every call with the api key it received", async () => {
    const fake = createFakeProvider("gemini");
    fake.script({ completions: [{ city: "goa" }] });
    await fake.validate("AIzaFirstKey", "gemini-2.5-pro");
    await fake.complete(completionOf({ apiKey: "AIzaSecondKey" }));

    expect(fake.calls).toEqual([
      { kind: "validate", apiKey: "AIzaFirstKey", model: "gemini-2.5-pro" },
      {
        kind: "complete",
        apiKey: "AIzaSecondKey",
        model: FAKE_MODEL,
        system: "you plan trips",
        user: "where should I go in December?",
        schemaName: "answer",
      },
    ]);

    fake.reset();
    expect(fake.calls).toEqual([]);
  });
});

describe("provider registry", () => {
  it("registry returns fake providers for all three ids when NOMAD_AI_FAKE=1", () => {
    expect(process.env.NOMAD_AI_FAKE).toBe("1");
    for (const id of PROVIDER_IDS) {
      const provider = getProvider(id);
      expect(provider.id).toBe(id);
      expect(provider.defaultModel).toBe(FAKE_MODEL);
      // The fake's surface, which a real adapter does not have.
      expect(provider).toHaveProperty("calls");
    }

    // useFakeProviders swaps in freshly scripted fakes and hands back handles.
    const fakes = useFakeProviders({ validate: { ok: true, model: "scripted" } });
    expect(getProvider("openai")).toBe(fakes.openai);
    expect(fakes.anthropic.calls).toEqual([]);

    resetProviders();
    expect(getProvider("openai")).not.toBe(fakes.openai);
  });

  it("global fetch throws inside the test environment", () => {
    expect(() => fetch("https://api.anthropic.com/v1/messages")).toThrow(
      /network access is not allowed/i,
    );
    // The fake never touches fetch at all, so it is unaffected by the stub.
    return expect(createFakeProvider("anthropic").validate("sk-ant-x")).resolves
      .toBeDefined();
  });
});
