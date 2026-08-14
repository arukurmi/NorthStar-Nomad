import { describe, it, expect } from "vitest";
import type { JsonResponse, RequestJson, RequestJsonArgs } from "../http.js";
import { AiError, type CompletionRequest } from "../provider.js";
import {
  ANTHROPIC_DEFAULT_MODEL,
  createAnthropicProvider,
  extractJson,
  extractUsage,
  mapError,
} from "./anthropic.js";
import success from "./__fixtures__/anthropic.success.json";
import textOnly from "./__fixtures__/anthropic.text-only.json";
import errors from "./__fixtures__/anthropic.errors.json";

/**
 * The dependency-injection seam the real adapter already uses: production
 * passes `requestJson`, tests pass this. No fetch, no key, no network.
 */
function transportOf(
  ...responses: Array<Partial<JsonResponse>>
): { calls: RequestJsonArgs[]; transport: RequestJson } {
  const calls: RequestJsonArgs[] = [];
  const queue = [...responses];
  const transport: RequestJson = async (args) => {
    calls.push(args);
    const next = queue.shift() ?? {};
    return {
      status: next.status ?? 200,
      headers: next.headers ?? new Headers(),
      body: next.body ?? success,
    };
  };
  return { calls, transport };
}

const SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    nights: { type: "integer", minimum: 1 },
  },
  required: ["city", "nights"],
  additionalProperties: false,
} as const;

interface Answer {
  city: string;
  nights: number;
}

function parseAnswer(value: unknown): Answer {
  const v = value as { city?: unknown; nights?: unknown } | null;
  if (typeof v?.city !== "string" || typeof v?.nights !== "number") {
    throw new Error("expected { city: string, nights: number }");
  }
  return { city: v.city, nights: v.nights };
}

function completionOf(
  overrides: Partial<CompletionRequest<Answer>> = {},
): CompletionRequest<Answer> {
  return {
    apiKey: "sk-ant-api03-LEAKCANARY-7f3a9c2e5b1d8046a2c9",
    model: ANTHROPIC_DEFAULT_MODEL,
    system: "you plan trips",
    user: "three nights somewhere warm",
    schema: SCHEMA as unknown as CompletionRequest<Answer>["schema"],
    schemaName: "answer",
    parse: parseAnswer,
    ...overrides,
  };
}

describe("anthropic adapter requests", () => {
  it("builds a validate request with max_tokens 1 and the x-api-key header", async () => {
    const { calls, transport } = transportOf({ status: 200, body: success });
    const provider = createAnthropicProvider({ transport });
    expect(provider.id).toBe("anthropic");
    expect(provider.defaultModel).toBe("claude-sonnet-5");

    const result = await provider.validate("sk-ant-api03-validate-me-0123456789");
    expect(result).toEqual({ ok: true, model: "claude-sonnet-5" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-ant-api03-validate-me-0123456789");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(call.timeoutMs).toBe(8_000);
  });

  it("sends the schema verbatim as input_schema with forced tool_choice", async () => {
    const { calls, transport } = transportOf({ status: 200, body: success });
    const provider = createAnthropicProvider({ transport });
    await provider.complete(completionOf({ maxTokens: 1024, temperature: 0.1 }));

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.1);
    expect(body.system).toBe("you plan trips");
    expect(body.messages).toEqual([
      { role: "user", content: "three nights somewhere warm" },
    ]);
    expect(body.tools).toEqual([
      {
        name: "answer",
        description: "Return the result using this schema.",
        // Verbatim: Anthropic takes plain JSON Schema, so nothing is rewritten.
        input_schema: SCHEMA,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "answer" });
    expect(calls[0]!.timeoutMs).toBe(45_000);
  });
});

describe("anthropic response mapping", () => {
  it("extracts the tool_use input block as the result", async () => {
    // Pre-parsed by the vendor, unlike Gemini and OpenAI, which send a string.
    expect(extractJson(success, "answer")).toEqual({ city: "Goa", nights: 3 });

    const { transport } = transportOf({ status: 200, body: success });
    const result = await createAnthropicProvider({ transport }).complete(
      completionOf(),
    );
    expect(result.data).toEqual({ city: "Goa", nights: 3 });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.retried).toBe(false);
  });

  it("throws bad_output when no tool_use block is present", async () => {
    const err = (() => {
      try {
        extractJson(textOnly, "answer");
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    expect((err as AiError).status).toBe(502);

    // A tool_use block under a different name is not our answer either.
    expect(() => extractJson(success, "some_other_tool")).toThrow(AiError);

    // Through the adapter: one retry, then bad_output rather than a hang.
    const { calls, transport } = transportOf(
      { status: 200, body: textOnly },
      { status: 200, body: textOnly },
    );
    const failure = await createAnthropicProvider({ transport })
      .complete(completionOf())
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect((failure as AiError).code).toBe("bad_output");
  });

  it("extracts input and output token counts from usage", async () => {
    expect(extractUsage(success)).toEqual({
      inputTokens: 412,
      outputTokens: 87,
    });
    // A body without usage counts as zero rather than NaN reaching ai_usage.
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });

    const { transport } = transportOf({ status: 200, body: success });
    const result = await createAnthropicProvider({ transport }).complete(
      completionOf(),
    );
    expect(result.inputTokens).toBe(412);
    expect(result.outputTokens).toBe(87);
  });
});

describe("anthropic error mapping", () => {
  it("maps 401 authentication_error to invalid_key", () => {
    const err = mapError(401, errors.authentication, new Headers());
    expect(err.code).toBe("invalid_key");
    expect(err.status).toBe(401);
    expect(err.provider).toBe("anthropic");
  });

  it("maps 403 permission_error to invalid_key", () => {
    const err = mapError(403, errors.permission, new Headers());
    expect(err.code).toBe("invalid_key");
    expect(err.status).toBe(401);
  });

  it("maps a 400 credit-balance message to insufficient_credit", () => {
    const err = mapError(400, errors.lowCredit, new Headers());
    expect(err.code).toBe("insufficient_credit");
    expect(err.status).toBe(402);

    // Any other 400 is our bug, not the user's wallet.
    const other = mapError(400, errors.badRequest, new Headers());
    expect(other.code).toBe("provider_error");
  });

  it("maps 429 to rate_limited and reads retry-after", () => {
    const err = mapError(
      429,
      errors.rateLimited,
      new Headers({ "retry-after": "12" }),
    );
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(12);

    // No header, and no guessing: the documented fallback.
    expect(mapError(429, errors.rateLimited, new Headers()).retryAfter).toBe(30);
  });

  it("maps 529 overloaded to provider_error with a retryAfter", () => {
    const err = mapError(529, errors.overloaded, new Headers());
    expect(err.code).toBe("provider_error");
    expect(err.status).toBe(502);
    expect(err.retryAfter).toBe(30);
  });

  it("maps 500 to provider_error", () => {
    expect(mapError(500, errors.serverError, new Headers()).code).toBe(
      "provider_error",
    );
    expect(mapError(503, errors.serverError, new Headers()).code).toBe(
      "provider_error",
    );
    // 404 names the model the user asked for, which is the actionable part.
    const notFound = mapError(
      404,
      errors.modelNotFound,
      new Headers(),
      "claude-sonnet-5-does-not-exist",
    );
    expect(notFound.code).toBe("provider_error");
    expect(notFound.message).toContain("claude-sonnet-5-does-not-exist");
  });

  it("never puts the api key in a thrown error message", async () => {
    const KEY = "sk-ant-api03-LEAKCANARY-7f3a9c2e5b1d8046a2c9";
    const MIDDLE = KEY.slice(8, 24);

    // The vendor echoed our request headers — including the key — back at us.
    const echoed = mapError(400, errors.echoesRequestHeaders, new Headers());
    expect(echoed.message).not.toContain(KEY);
    expect(echoed.message).not.toContain(MIDDLE);
    expect(JSON.stringify(echoed.toJSON())).not.toContain(MIDDLE);

    // And through the adapter, where the key is genuinely in scope.
    const { transport } = transportOf({
      status: 400,
      body: errors.echoesRequestHeaders,
    });
    const thrown = (await createAnthropicProvider({ transport })
      .complete(completionOf({ apiKey: KEY }))
      .catch((e: unknown) => e)) as AiError;
    expect(thrown).toBeInstanceOf(AiError);
    expect(thrown.message).not.toContain(MIDDLE);
    expect(JSON.stringify(thrown.toJSON())).not.toContain(MIDDLE);

    // validate() takes the same care on its non-ok path.
    const { transport: validateTransport } = transportOf({
      status: 401,
      body: errors.echoesRequestHeaders,
    });
    const result = await createAnthropicProvider({
      transport: validateTransport,
    }).validate(KEY);
    expect(JSON.stringify(result)).not.toContain(MIDDLE);
  });
});
