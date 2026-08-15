import { describe, it, expect } from "vitest";
import type { JsonResponse, RequestJson, RequestJsonArgs } from "../http.js";
import { AiError, type CompletionRequest, type JsonSchemaObject } from "../provider.js";
import {
  createGeminiProvider,
  extractJson,
  extractUsage,
  GEMINI_DEFAULT_MODEL,
  mapError,
  toVendorSchema,
} from "./gemini.js";
import success from "./__fixtures__/gemini.success.json";
import modelsGet from "./__fixtures__/gemini.models-get.json";
import blocked from "./__fixtures__/gemini.blocked.json";
import errors from "./__fixtures__/gemini.errors.json";

const API_KEY = "AIzaLEAKCANARY7f3a9c2e5b1d8046a2c9zzzz";

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

/** Carries every keyword Gemini rejects, so the transform has work to do. */
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Answer",
  type: "object",
  additionalProperties: false,
  properties: {
    city: { type: "string", description: "where to go" },
    nights: { type: "integer", minimum: 1, maximum: 14 },
    mode: { type: "string", enum: ["beach", "mountain"] },
    highlights: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          cost: { type: "number", minimum: 0, default: 0 },
        },
        required: ["label", "cost"],
      },
    },
  },
  required: ["city", "nights", "mode", "highlights"],
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
    model: GEMINI_DEFAULT_MODEL,
    system: "you plan trips",
    user: "three nights somewhere warm",
    schema: SCHEMA,
    schemaName: "answer",
    parse: parseAnswer,
    ...overrides,
  };
}

describe("gemini adapter requests", () => {
  it("validate calls models.get and sends the key as the x-goog-api-key header", async () => {
    const { calls, transport } = transportOf({ status: 200, body: modelsGet });
    const provider = createGeminiProvider({ transport });
    expect(provider.id).toBe("gemini");
    expect(provider.defaultModel).toBe("gemini-2.5-pro");

    const result = await provider.validate(API_KEY);
    expect(result).toEqual({ ok: true, model: "gemini-2.5-pro" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro",
    );
    expect(call.headers["x-goog-api-key"]).toBe(API_KEY);
    // models.get costs zero tokens, so there is no body at all.
    expect(call.body).toBeUndefined();
    expect(call.timeoutMs).toBe(8_000);
  });

  it("never places the api key in the request URL", async () => {
    const { calls, transport } = transportOf(
      { status: 200, body: modelsGet },
      { status: 200, body: success },
    );
    const provider = createGeminiProvider({ transport });
    await provider.validate(API_KEY);
    await provider.complete(completionOf());

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // A key in a query string lands in access logs, proxy logs and Referer.
      expect(call.url).not.toContain(API_KEY);
      expect(call.url).not.toContain(API_KEY.slice(4, 20));
      expect(call.url).not.toContain("key=");
      expect(call.url).not.toContain("?");
      // It travels in the header on every call instead.
      expect(call.headers["x-goog-api-key"]).toBe(API_KEY);
    }
    expect(calls[1]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
  });
});

describe("gemini schema translation", () => {
  it("toVendorSchema strips additionalProperties and $schema", () => {
    const converted = toVendorSchema(SCHEMA) as Record<string, unknown>;
    expect(converted).not.toHaveProperty("$schema");
    expect(converted).not.toHaveProperty("title");
    expect(converted).not.toHaveProperty("additionalProperties");

    // Recursively — a nested object node is stripped the same way.
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    expect(properties.highlights!.items).not.toHaveProperty("additionalProperties");

    // What survives is the documented OpenAPI subset.
    expect(converted.type).toBe("object");
    expect(converted.required).toEqual(["city", "nights", "mode", "highlights"]);
    expect(properties.city).toEqual({
      type: "string",
      description: "where to go",
    });
    expect(properties.mode!.enum).toEqual(["beach", "mountain"]);

    // enum is only legal alongside a string type; anything else is our bug.
    expect(() =>
      toVendorSchema({
        type: "object",
        properties: { n: { type: "integer", enum: [1, 2] } },
      } as unknown as JsonSchemaObject),
    ).toThrow(AiError);
  });

  it("toVendorSchema strips minimum, maximum, minItems and maxItems", () => {
    const converted = toVendorSchema(SCHEMA) as Record<string, unknown>;
    const properties = converted.properties as Record<string, Record<string, unknown>>;

    expect(properties.nights).toEqual({ type: "integer" });
    expect(properties.highlights).not.toHaveProperty("minItems");
    expect(properties.highlights).not.toHaveProperty("maxItems");

    const items = properties.highlights!.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.cost).toEqual({ type: "number" });
    expect(itemProps.cost).not.toHaveProperty("default");

    // Nothing outside the whitelist survives anywhere in the tree.
    const serialised = JSON.stringify(converted);
    for (const banned of ["minimum", "maximum", "minItems", "maxItems", "default"]) {
      expect(serialised).not.toContain(banned);
    }
  });

  it("toVendorSchema emits propertyOrdering matching the property keys", () => {
    const converted = toVendorSchema(SCHEMA) as Record<string, unknown>;
    expect(converted.propertyOrdering).toEqual([
      "city",
      "nights",
      "mode",
      "highlights",
    ]);
    expect(converted.propertyOrdering).toEqual(
      Object.keys(converted.properties as Record<string, unknown>),
    );

    // Every object node gets one, including nested ones.
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    const items = properties.highlights!.items as Record<string, unknown>;
    expect(items.propertyOrdering).toEqual(["label", "cost"]);
    // A leaf has no properties, so it has no ordering either.
    expect(properties.city).not.toHaveProperty("propertyOrdering");
  });
});

describe("gemini response mapping", () => {
  it("parses the JSON string in candidates[0].content.parts[0].text", async () => {
    // A string, not a parsed object — the one structural difference from
    // Anthropic, and the reason this function exists per vendor.
    expect(extractJson(success)).toEqual({ city: "Goa", nights: 3 });

    const { calls, transport } = transportOf({ status: 200, body: success });
    const result = await createGeminiProvider({ transport }).complete(
      completionOf({ maxTokens: 2048, temperature: 0.2 }),
    );
    expect(result.data).toEqual({ city: "Goa", nights: 3 });
    expect(result.provider).toBe("gemini");
    expect(result.retried).toBe(false);

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "you plan trips" }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "three nights somewhere warm" }] },
    ]);
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.temperature).toBe(0.2);
    expect(config.maxOutputTokens).toBe(2048);
    expect(config.responseSchema).toEqual(toVendorSchema(SCHEMA));

    // Text that is not JSON at all is bad_output, retried exactly once.
    const retryTransport = transportOf(
      { status: 200, body: blocked.notJson },
      { status: 200, body: blocked.notJson },
    );
    const failure = await createGeminiProvider({
      transport: retryTransport.transport,
    })
      .complete(completionOf())
      .catch((e: unknown) => e);
    expect(retryTransport.calls).toHaveLength(2);
    expect((failure as AiError).code).toBe("bad_output");
  });

  it("throws bad_output when finishReason is SAFETY", async () => {
    const err = (() => {
      try {
        extractJson(blocked.safety);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    expect((err as AiError).message).toContain("SAFETY");

    expect(() => extractJson(blocked.recitation)).toThrow(/RECITATION/);

    // A settled block is not retried — a second call would cost the user money
    // to be told the same thing.
    const { calls, transport } = transportOf({ status: 200, body: blocked.safety });
    const thrown = await createGeminiProvider({ transport })
      .complete(completionOf())
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect((thrown as AiError).code).toBe("bad_output");
  });

  it("throws bad_output when finishReason is MAX_TOKENS", () => {
    // The text part holds truncated, unparseable JSON; the reason is what the
    // caller actually needs to see, so it is named in the message.
    const err = (() => {
      try {
        extractJson(blocked.maxTokens);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe("bad_output");
    expect((err as AiError).status).toBe(502);
    expect((err as AiError).message).toContain("MAX_TOKENS");
  });

  it("extracts usage from usageMetadata", async () => {
    expect(extractUsage(success)).toEqual({
      inputTokens: 355,
      outputTokens: 64,
    });
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });

    const { transport } = transportOf({ status: 200, body: success });
    const result = await createGeminiProvider({ transport }).complete(
      completionOf(),
    );
    expect(result.inputTokens).toBe(355);
    expect(result.outputTokens).toBe(64);
  });
});

describe("gemini error mapping", () => {
  it('maps "API key not valid" to invalid_key', () => {
    const err = mapError(400, errors.apiKeyNotValid, new Headers());
    expect(err.code).toBe("invalid_key");
    expect(err.status).toBe(401);
    expect(err.provider).toBe("gemini");

    // Any other INVALID_ARGUMENT is our responseSchema, not the user's key.
    const ours = mapError(400, errors.invalidArgument, new Headers());
    expect(ours.code).toBe("provider_error");

    // The vendor message is classified, never surfaced: it can echo the key.
    const echoed = mapError(400, errors.echoesRequestHeaders, new Headers());
    expect(echoed.message).not.toContain(API_KEY);
    expect(JSON.stringify(echoed.toJSON())).not.toContain(API_KEY.slice(4, 20));
  });

  it("maps PERMISSION_DENIED to invalid_key", () => {
    expect(mapError(403, errors.permissionDenied, new Headers()).code).toBe(
      "invalid_key",
    );
    expect(mapError(401, errors.unauthenticated, new Headers()).code).toBe(
      "invalid_key",
    );
  });

  it("maps RESOURCE_EXHAUSTED with a billing message to insufficient_credit", () => {
    const err = mapError(429, errors.quotaBilling, new Headers());
    expect(err.code).toBe("insufficient_credit");
    expect(err.status).toBe(402);
    // Out of money is not the same as going too fast: no Retry-After.
    expect(err.retryAfter).toBeUndefined();
  });

  it('maps a plain 429 to rate_limited and parses retryDelay "27s" to 27', () => {
    const err = mapError(429, errors.rateLimited, new Headers());
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(27);

    // RetryInfo wins over the header; the header is the fallback.
    const headerOnly = mapError(
      429,
      errors.quotaBilling,
      new Headers({ "retry-after": "11" }),
    );
    expect(headerOnly.code).toBe("insufficient_credit");
    const noDetails = mapError(
      429,
      { error: { status: "RESOURCE_EXHAUSTED", message: "slow down" } },
      new Headers({ "retry-after": "11" }),
    );
    expect(noDetails.retryAfter).toBe(11);

    // Neither present: the documented fallback rather than a guess.
    const bare = mapError(
      429,
      { error: { status: "RESOURCE_EXHAUSTED", message: "slow down" } },
      new Headers(),
    );
    expect(bare.retryAfter).toBe(30);
  });

  it("maps 503 UNAVAILABLE to provider_error", () => {
    expect(mapError(503, errors.unavailable, new Headers()).code).toBe(
      "provider_error",
    );
    expect(mapError(500, errors.internal, new Headers()).code).toBe(
      "provider_error",
    );
    const notFound = mapError(404, errors.notFound, new Headers());
    expect(notFound.code).toBe("provider_error");
    expect(notFound.status).toBe(502);
  });
});
