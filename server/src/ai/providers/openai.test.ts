import { describe, it, expect } from "vitest";
import type { JsonResponse, RequestJson, RequestJsonArgs } from "../http.js";
import { AiError, type CompletionRequest, type JsonSchemaObject } from "../provider.js";
import {
  createOpenAiProvider,
  extractJson,
  extractUsage,
  mapError,
  OPENAI_DEFAULT_MODEL,
  toVendorSchema,
} from "./openai.js";
import success from "./__fixtures__/openai.success.json";
import models from "./__fixtures__/openai.models.json";
import blocked from "./__fixtures__/openai.blocked.json";
import errors from "./__fixtures__/openai.errors.json";

const API_KEY = "sk-proj-LEAKCANARY7f3a9c2e5b1d8046a2c9";

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

/** Deliberately loose: optional fields and ranges, which strict mode forbids. */
const SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string", description: "where to go" },
    nights: { type: "integer", minimum: 1, maximum: 14 },
    highlights: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          cost: { type: "number", minimum: 0 },
        },
        required: ["label"],
      },
    },
  },
  required: ["city"],
} as unknown as JsonSchemaObject;

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
    apiKey: API_KEY,
    model: OPENAI_DEFAULT_MODEL,
    system: "you plan trips",
    user: "three nights somewhere warm",
    schema: SCHEMA,
    schemaName: "answer",
    parse: parseAnswer,
    ...overrides,
  };
}

/** The request body of the nth recorded call. */
function bodyOf(calls: RequestJsonArgs[], index = 0): Record<string, unknown> {
  return calls[index]!.body as Record<string, unknown>;
}

describe("openai adapter requests", () => {
  it("validate issues GET /v1/models with a bearer token", async () => {
    const { calls, transport } = transportOf({ status: 200, body: models });
    const provider = createOpenAiProvider({ transport });
    expect(provider.id).toBe("openai");
    expect(provider.defaultModel).toBe("gpt-5");

    const result = await provider.validate(API_KEY);
    expect(result).toEqual({ ok: true, model: "gpt-5" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.openai.com/v1/models");
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    // A free list call: zero tokens, and therefore no body.
    expect(call.body).toBeUndefined();
    expect(call.timeoutMs).toBe(8_000);
    // The key never reaches the URL — it is a header, as everywhere else.
    expect(call.url).not.toContain(API_KEY.slice(8, 24));
  });

  it("sends response_format json_schema with strict true", async () => {
    const { calls, transport } = transportOf({ status: 200, body: success });
    await createOpenAiProvider({ transport }).complete(completionOf());

    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = bodyOf(calls);
    expect(body.model).toBe("gpt-5");
    expect(body.messages).toEqual([
      { role: "system", content: "you plan trips" },
      { role: "user", content: "three nights somewhere warm" },
    ]);

    const format = body.response_format as {
      type: string;
      json_schema: Record<string, unknown>;
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("answer");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toEqual(toVendorSchema(SCHEMA));
  });
});

describe("openai schema translation", () => {
  it("toVendorSchema sets additionalProperties false on every object", () => {
    const converted = toVendorSchema(SCHEMA) as Record<string, unknown>;
    expect(converted.additionalProperties).toBe(false);

    // Recursively: a nested object that misses this 400s the whole request.
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    const items = properties.highlights!.items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);

    // Range keywords are unsupported under strict and are dropped.
    const serialised = JSON.stringify(converted);
    for (const banned of ["minimum", "maximum", "minItems", "maxItems"]) {
      expect(serialised).not.toContain(banned);
    }
    expect(properties.nights).toEqual({ type: "integer" });
    expect(properties.city).toEqual({
      type: "string",
      description: "where to go",
    });
  });

  it("toVendorSchema marks every property required", () => {
    const converted = toVendorSchema(SCHEMA) as Record<string, unknown>;
    // The source schema required only "city"; strict mode forbids optional
    // fields, so all three are listed.
    expect(converted.required).toEqual(["city", "nights", "highlights"]);
    expect(converted.required).toEqual(
      Object.keys(converted.properties as Record<string, unknown>),
    );

    const properties = converted.properties as Record<string, Record<string, unknown>>;
    const items = properties.highlights!.items as Record<string, unknown>;
    expect(items.required).toEqual(["label", "cost"]);
    // A leaf has no properties, so it gets neither required nor a false flag.
    expect(properties.city).not.toHaveProperty("required");
    expect(properties.city).not.toHaveProperty("additionalProperties");
  });
});

describe("openai model-family quirks", () => {
  it("uses max_completion_tokens rather than max_tokens", async () => {
    const { calls, transport } = transportOf({ status: 200, body: success });
    await createOpenAiProvider({ transport }).complete(
      completionOf({ maxTokens: 1024 }),
    );
    const body = bodyOf(calls);
    // gpt-5 rejects `max_tokens` outright, so the older name is never sent.
    expect(body.max_completion_tokens).toBe(1024);
    expect(body).not.toHaveProperty("max_tokens");

    const fallback = transportOf({ status: 200, body: success });
    await createOpenAiProvider({ transport: fallback.transport }).complete(
      completionOf(),
    );
    expect(bodyOf(fallback.calls).max_completion_tokens).toBe(4096);
  });

  it("omits temperature for gpt-5", async () => {
    for (const model of ["gpt-5", "gpt-5-mini", "o3", "o4-mini"]) {
      const { calls, transport } = transportOf({ status: 200, body: success });
      await createOpenAiProvider({ transport }).complete(
        // Even when the caller asks for one: these models take only the
        // default and 400 on anything else.
        completionOf({ model, temperature: 0.9 }),
      );
      expect(bodyOf(calls)).not.toHaveProperty("temperature");
    }
  });

  it("sends temperature for a non-reasoning model", async () => {
    const { calls, transport } = transportOf({ status: 200, body: success });
    await createOpenAiProvider({ transport }).complete(
      completionOf({ model: "gpt-4o-mini", temperature: 0.9 }),
    );
    expect(bodyOf(calls).temperature).toBe(0.9);

    const defaulted = transportOf({ status: 200, body: success });
    await createOpenAiProvider({ transport: defaulted.transport }).complete(
      completionOf({ model: "gpt-4o-mini" }),
    );
    expect(bodyOf(defaulted.calls).temperature).toBe(0.4);
  });
});

describe("openai response mapping", () => {
  it("parses choices[0].message.content as JSON", async () => {
    expect(extractJson(success)).toEqual({ city: "Goa", nights: 3 });
    expect(extractUsage(success)).toEqual({
      inputTokens: 388,
      outputTokens: 52,
    });
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });

    const { transport } = transportOf({ status: 200, body: success });
    const result = await createOpenAiProvider({ transport }).complete(
      completionOf(),
    );
    expect(result.data).toEqual({ city: "Goa", nights: 3 });
    expect(result.provider).toBe("openai");
    expect(result.inputTokens).toBe(388);
    expect(result.outputTokens).toBe(52);
    expect(result.retried).toBe(false);

    // Prose instead of JSON is retried once, then bad_output.
    const retry = transportOf(
      { status: 200, body: blocked.notJson },
      { status: 200, body: success },
    );
    const retried = await createOpenAiProvider({
      transport: retry.transport,
    }).complete(completionOf());
    expect(retry.calls).toHaveLength(2);
    expect(retried.retried).toBe(true);
    expect(retried.data).toEqual({ city: "Goa", nights: 3 });
  });

  it("throws bad_output on a refusal", async () => {
    const err = (() => {
      try {
        extractJson(blocked.refusal);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    expect((err as AiError).status).toBe(502);
    expect((err as AiError).message).toContain("the model refused:");
    expect((err as AiError).message).toContain("I'm sorry");

    // A refusal is settled — the adapter does not spend a retry on it.
    const { calls, transport } = transportOf({
      status: 200,
      body: blocked.refusal,
    });
    const thrown = await createOpenAiProvider({ transport })
      .complete(completionOf())
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect((thrown as AiError).code).toBe("bad_output");
  });

  it("throws bad_output when finish_reason is length", () => {
    const err = (() => {
      try {
        extractJson(blocked.truncated);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    // Named, because the fix is a bigger maxTokens rather than a retry.
    expect((err as AiError).message).toBe("response was truncated");
  });
});

describe("openai error mapping", () => {
  it("maps 401 invalid_api_key to invalid_key", () => {
    const err = mapError(401, errors.invalidApiKey, new Headers());
    expect(err.code).toBe("invalid_key");
    expect(err.status).toBe(401);
    expect(err.provider).toBe("openai");
    // OpenAI quotes the rejected key back at us; it stops here.
    expect(err.message).not.toContain(API_KEY);
    expect(JSON.stringify(err.toJSON())).not.toContain(API_KEY.slice(8, 24));
  });

  it("maps 429 insufficient_quota to insufficient_credit", () => {
    const err = mapError(429, errors.insufficientQuota, new Headers());
    expect(err.code).toBe("insufficient_credit");
    expect(err.status).toBe(402);
    // Out of money is not "go slower": no Retry-After is offered.
    expect(err.retryAfter).toBeUndefined();
  });

  it("maps a plain 429 to rate_limited", () => {
    const err = mapError(
      429,
      errors.rateLimited,
      new Headers({ "retry-after": "9" }),
    );
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(9);
    // No header: the documented fallback for this vendor.
    expect(mapError(429, errors.rateLimited, new Headers()).retryAfter).toBe(20);
  });

  it("maps 404 model_not_found to provider_error", () => {
    const err = mapError(404, errors.modelNotFound, new Headers(), "gpt-5");
    expect(err.code).toBe("provider_error");
    expect(err.status).toBe(502);
    expect(err.message).toContain("gpt-5");

    // The rest of the table, which all lands on provider_error.
    expect(mapError(403, errors.unsupportedRegion, new Headers()).code).toBe(
      "provider_error",
    );
    expect(mapError(400, errors.contextLength, new Headers()).code).toBe(
      "provider_error",
    );
    const ours = mapError(400, errors.responseFormat, new Headers());
    expect(ours.code).toBe("provider_error");
    expect(ours.message).toContain("bug on our side");
    expect(mapError(500, errors.serverError, new Headers()).code).toBe(
      "provider_error",
    );
    expect(mapError(503, errors.serverError, new Headers()).code).toBe(
      "provider_error",
    );
  });
});
