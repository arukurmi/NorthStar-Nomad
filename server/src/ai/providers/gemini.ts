import { requestJson, type RequestJson } from "../http.js";
import {
  AiError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
  type JsonSchemaObject,
  type ProviderId,
  type ValidationResult,
} from "../provider.js";

const PROVIDER: ProviderId = "gemini";

export const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const VALIDATE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.4;
const RATE_LIMIT_FALLBACK_SECONDS = 30;

/** Reasons Gemini stops without producing the JSON we asked for. */
const BLOCKING_FINISH_REASONS = new Set(["SAFETY", "RECITATION", "MAX_TOKENS"]);

/**
 * The key goes in a header, never `?key=`. A query string lands in access logs,
 * proxy logs and `Referer`; a header does not. `modelUrl` below is the only
 * place a URL is built, so that property is checkable in one place.
 */
function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
    "content-type": "application/json",
  };
}

function modelUrl(model: string, method?: string): string {
  const path = `${BASE_URL}/models/${encodeURIComponent(model)}`;
  return method === undefined ? path : `${path}:${method}`;
}

/**
 * Google's error text is read only to classify. It has echoed request payloads
 * back in `error.message`, and a request payload can carry the API key header,
 * so nothing from here is ever surfaced.
 */
function vendorError(body: unknown): {
  status: string;
  message: string;
  details: unknown[];
} {
  const error = (
    body as {
      error?: { status?: unknown; message?: unknown; details?: unknown };
    } | null
  )?.error;
  return {
    status: typeof error?.status === "string" ? error.status : "",
    message: typeof error?.message === "string" ? error.message : "",
    details: Array.isArray(error?.details) ? error.details : [],
  };
}

/** `"27s"` → `27`. Google states the backoff in `RetryInfo.retryDelay`. */
function retryDelaySeconds(details: unknown[]): number | null {
  for (const detail of details) {
    const raw = (detail as { retryDelay?: unknown } | null)?.retryDelay;
    if (typeof raw !== "string") continue;
    const parsed = Number.parseFloat(raw.replace(/s$/, ""));
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  return null;
}

function retryAfterHeader(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Gemini status/`error.status` → the shared six-code taxonomy. */
export function mapError(status: number, body: unknown, headers: Headers): AiError {
  const { status: rpc, message, details } = vendorError(body);
  const opts = { provider: PROVIDER };

  if (status === 401 || status === 403 || rpc === "PERMISSION_DENIED" || rpc === "UNAUTHENTICATED") {
    return new AiError("invalid_key", "Google rejected this API key", opts);
  }
  if (status === 400) {
    if (/API key not valid/i.test(message)) {
      return new AiError("invalid_key", "Google rejected this API key", opts);
    }
    // An INVALID_ARGUMENT that is not about the key is almost always our
    // responseSchema, so it is our bug and never the user's credit or quota.
    return new AiError("provider_error", "Google rejected the request", opts);
  }
  if (status === 429 || rpc === "RESOURCE_EXHAUSTED") {
    if (/billing|free tier/i.test(message)) {
      return new AiError(
        "insufficient_credit",
        "this Google project has no billing enabled for that model",
        opts,
      );
    }
    return new AiError("rate_limited", "Google is rate limiting this key", {
      ...opts,
      retryAfter:
        retryDelaySeconds(details) ??
        retryAfterHeader(headers) ??
        RATE_LIMIT_FALLBACK_SECONDS,
    });
  }
  if (status === 404) {
    return new AiError(
      "provider_error",
      "that model is not available to this Google API key",
      opts,
    );
  }
  return new AiError("provider_error", "Google returned an error", opts);
}

/**
 * `responseSchema` is an OpenAPI 3.0 subset, not JSON Schema: an unsupported
 * keyword is a 400, not a warning. So this whitelists the six keywords Google
 * documents rather than blacklisting today's known-bad ones — a keyword added
 * to our internal schema later cannot silently start breaking Gemini.
 */
export function toVendorSchema(schema: JsonSchemaObject): unknown {
  return convertNode(schema);
}

function convertNode(node: unknown): unknown {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof src.type === "string") out.type = src.type;
  if (typeof src.description === "string") out.description = src.description;

  if (Array.isArray(src.enum)) {
    if (src.type !== "string") {
      throw new AiError(
        "provider_error",
        "schema error: enum is only valid on a string field",
        { provider: PROVIDER },
      );
    }
    out.enum = [...src.enum];
  }

  if (src.properties !== null && typeof src.properties === "object") {
    const properties = src.properties as Record<string, unknown>;
    const keys = Object.keys(properties);
    const converted: Record<string, unknown> = {};
    for (const key of keys) converted[key] = convertNode(properties[key]);
    out.properties = converted;
    // Stabilises field order, which measurably improves nested-object quality.
    out.propertyOrdering = keys;
  }

  if (Array.isArray(src.required)) out.required = [...src.required];
  if (src.items !== undefined) out.items = convertNode(src.items);

  return out;
}

function firstCandidate(body: unknown): Record<string, unknown> | null {
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  return first !== null && typeof first === "object"
    ? (first as Record<string, unknown>)
    : null;
}

/** The finishReason that stopped a usable answer, or null when there is none. */
export function blockedReason(body: unknown): string | null {
  const reason = firstCandidate(body)?.finishReason;
  return typeof reason === "string" && BLOCKING_FINISH_REASONS.has(reason)
    ? reason
    : null;
}

/**
 * Gemini returns the object as a JSON *string* in a text part, unlike
 * Anthropic's pre-parsed tool input — so this parses, and a truncated or
 * blocked answer surfaces as `bad_output` naming the reason.
 */
export function extractJson(body: unknown): unknown {
  const blocked = blockedReason(body);
  if (blocked !== null) {
    throw new AiError("bad_output", `Gemini stopped early (${blocked})`, {
      provider: PROVIDER,
    });
  }

  const content = firstCandidate(body)?.content;
  const parts = (content as { parts?: unknown } | null)?.parts;
  const text = Array.isArray(parts)
    ? (parts[0] as { text?: unknown } | null)?.text
    : undefined;
  if (typeof text !== "string") {
    throw new AiError("bad_output", "Gemini returned no text part", {
      provider: PROVIDER,
    });
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AiError("bad_output", "Gemini's answer was not valid JSON", {
      provider: PROVIDER,
      cause: err,
    });
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function extractUsage(body: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage = (
    body as {
      usageMetadata?: {
        promptTokenCount?: unknown;
        candidatesTokenCount?: unknown;
      };
    } | null
  )?.usageMetadata;
  return {
    inputTokens: count(usage?.promptTokenCount),
    outputTokens: count(usage?.candidatesTokenCount),
  };
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function badOutput(err: unknown): AiError {
  if (err instanceof AiError && err.code === "bad_output") return err;
  return new AiError(
    "bad_output",
    "Gemini's answer did not match the expected schema",
    { provider: PROVIDER, cause: err },
  );
}

export interface GeminiOptions {
  /** Injected in tests; production gets the real `requestJson`. */
  transport?: RequestJson;
}

export function createGeminiProvider(options: GeminiOptions = {}): AiProvider {
  const transport = options.transport ?? requestJson;

  return {
    id: PROVIDER,
    defaultModel: GEMINI_DEFAULT_MODEL,

    async validate(apiKey: string, model?: string): Promise<ValidationResult> {
      const chosen = model ?? GEMINI_DEFAULT_MODEL;
      try {
        // models.get costs zero tokens — strictly cheaper than generating.
        const res = await transport({
          url: modelUrl(chosen),
          method: "GET",
          headers: geminiHeaders(apiKey),
          timeoutMs: VALIDATE_TIMEOUT_MS,
        });
        if (isOk(res.status)) return { ok: true, model: chosen };
        const err = mapError(res.status, res.body, res.headers);
        return {
          ok: false,
          code: err.code,
          message: err.message,
          retryAfter: err.retryAfter,
        };
      } catch (err) {
        const aiError = AiError.from(err);
        return { ok: false, code: aiError.code, message: aiError.message };
      }
    },

    async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toVendorSchema(req.schema),
          temperature: req.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        },
      };

      let lastFailure: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await transport({
          url: modelUrl(req.model, "generateContent"),
          method: "POST",
          headers: geminiHeaders(req.apiKey),
          body,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (!isOk(res.status)) {
          throw mapError(res.status, res.body, res.headers);
        }
        // A safety block or a truncation is settled — retrying spends the
        // user's money to get the same answer, so only bad JSON is retried.
        const blocked = blockedReason(res.body);
        if (blocked !== null) {
          throw new AiError("bad_output", `Gemini stopped early (${blocked})`, {
            provider: PROVIDER,
          });
        }
        try {
          const data = req.parse(extractJson(res.body));
          const usage = extractUsage(res.body);
          return {
            data,
            provider: PROVIDER,
            model: req.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            retried: attempt > 0,
          };
        } catch (err) {
          lastFailure = err;
        }
      }
      throw badOutput(lastFailure);
    },
  };
}
