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

const PROVIDER: ProviderId = "openai";

export const OPENAI_DEFAULT_MODEL = "gpt-5";

const MODELS_URL = "https://api.openai.com/v1/models";
const COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const VALIDATE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.4;
const RATE_LIMIT_FALLBACK_SECONDS = 20;

/** Reasoning models accept only the default temperature and 400 otherwise. */
const FIXED_TEMPERATURE_MODELS = /^(gpt-5|o\d)/;

function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

/**
 * OpenAI quotes the offending key back in its 401 message ("Incorrect API key
 * provided: sk-..."), so vendor text is read here to classify the failure and
 * is never used as the message we surface.
 */
function vendorError(body: unknown): { code: string; type: string; param: string } {
  const error = (
    body as { error?: { code?: unknown; type?: unknown; param?: unknown } } | null
  )?.error;
  return {
    code: typeof error?.code === "string" ? error.code : "",
    type: typeof error?.type === "string" ? error.type : "",
    param: typeof error?.param === "string" ? error.param : "",
  };
}

function retryAfterHeader(headers: Headers, fallback: number): number {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** OpenAI status/`error.code` → the shared six-code taxonomy. */
export function mapError(
  status: number,
  body: unknown,
  headers: Headers,
  model?: string,
): AiError {
  const { code, type, param } = vendorError(body);
  const opts = { provider: PROVIDER };

  if (status === 401 || code === "invalid_api_key") {
    return new AiError("invalid_key", "OpenAI rejected this API key", opts);
  }
  if (code === "insufficient_quota" || type === "insufficient_quota") {
    return new AiError(
      "insufficient_credit",
      "this OpenAI account is out of quota — add billing to continue",
      opts,
    );
  }
  if (status === 429) {
    return new AiError("rate_limited", "OpenAI is rate limiting this key", {
      ...opts,
      retryAfter: retryAfterHeader(headers, RATE_LIMIT_FALLBACK_SECONDS),
    });
  }
  if (status === 403) {
    // A key can be perfectly valid and still be refused from this location,
    // so this is deliberately not invalid_key: re-pasting it will not help.
    return new AiError(
      "provider_error",
      "OpenAI does not serve this country or region",
      opts,
    );
  }
  if (status === 404 || code === "model_not_found") {
    const named = model === undefined ? "that model" : model;
    return new AiError(
      "provider_error",
      `your account has no access to ${named}`,
      opts,
    );
  }
  if (status === 400) {
    if (code === "context_length_exceeded") {
      return new AiError(
        "provider_error",
        "the request was longer than the model's context window",
        opts,
      );
    }
    if (param === "response_format" || /response_format/.test(code)) {
      // Ours, not the user's — say so, because nothing they do fixes it.
      return new AiError(
        "provider_error",
        "the structured-output schema was rejected by OpenAI — this is a bug on our side",
        opts,
      );
    }
    return new AiError("provider_error", "OpenAI rejected the request", opts);
  }
  return new AiError("provider_error", "OpenAI returned an error", opts);
}

/**
 * Strict mode has hard requirements: every object must forbid extra properties
 * and must list *every* property in `required` (a genuinely optional field has
 * to be a union with null in the schema instead), and range keywords are not
 * supported. Applied recursively — a nested object that misses any of this is
 * a 400 for the whole request.
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
  if (Array.isArray(src.enum)) out.enum = [...src.enum];

  if (src.properties !== null && typeof src.properties === "object") {
    const properties = src.properties as Record<string, unknown>;
    const keys = Object.keys(properties);
    const converted: Record<string, unknown> = {};
    for (const key of keys) converted[key] = convertNode(properties[key]);
    out.properties = converted;
    out.required = keys;
    out.additionalProperties = false;
  }

  if (src.items !== undefined) out.items = convertNode(src.items);

  return out;
}

function firstChoice(body: unknown): Record<string, unknown> | null {
  const choices = (body as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return first !== null && typeof first === "object"
    ? (first as Record<string, unknown>)
    : null;
}

/** A refusal or a truncation — settled outcomes a retry cannot improve. */
export function blockedReason(body: unknown): string | null {
  const choice = firstChoice(body);
  if (choice === null) return null;
  const refusal = (choice.message as { refusal?: unknown } | null)?.refusal;
  if (typeof refusal === "string" && refusal !== "") {
    return `the model refused: ${refusal.slice(0, 200)}`;
  }
  if (choice.finish_reason === "length") return "response was truncated";
  return null;
}

export function extractJson(body: unknown): unknown {
  const blocked = blockedReason(body);
  if (blocked !== null) {
    throw new AiError("bad_output", blocked, { provider: PROVIDER });
  }

  const content = (firstChoice(body)?.message as { content?: unknown } | null)
    ?.content;
  if (typeof content !== "string") {
    throw new AiError("bad_output", "OpenAI returned no message content", {
      provider: PROVIDER,
    });
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new AiError("bad_output", "OpenAI's answer was not valid JSON", {
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
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null
  )?.usage;
  return {
    inputTokens: count(usage?.prompt_tokens),
    outputTokens: count(usage?.completion_tokens),
  };
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function badOutput(err: unknown): AiError {
  if (err instanceof AiError && err.code === "bad_output") return err;
  return new AiError(
    "bad_output",
    "OpenAI's answer did not match the expected schema",
    { provider: PROVIDER, cause: err },
  );
}

export interface OpenAiOptions {
  /** Injected in tests; production gets the real `requestJson`. */
  transport?: RequestJson;
}

export function createOpenAiProvider(options: OpenAiOptions = {}): AiProvider {
  const transport = options.transport ?? requestJson;

  return {
    id: PROVIDER,
    defaultModel: OPENAI_DEFAULT_MODEL,

    async validate(apiKey: string, model?: string): Promise<ValidationResult> {
      const chosen = model ?? OPENAI_DEFAULT_MODEL;
      try {
        // A free list call: zero tokens. It proves the key, not the model —
        // a model the account cannot reach surfaces on first use instead.
        const res = await transport({
          url: MODELS_URL,
          method: "GET",
          headers: openaiHeaders(apiKey),
          timeoutMs: VALIDATE_TIMEOUT_MS,
        });
        if (isOk(res.status)) return { ok: true, model: chosen };
        const err = mapError(res.status, res.body, res.headers, chosen);
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
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: req.schemaName,
            strict: true,
            schema: toVendorSchema(req.schema),
          },
        },
        // Not `max_tokens`: gpt-5 rejects the older name outright.
        max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (!FIXED_TEMPERATURE_MODELS.test(req.model)) {
        body.temperature = req.temperature ?? DEFAULT_TEMPERATURE;
      }

      let lastFailure: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await transport({
          url: COMPLETIONS_URL,
          method: "POST",
          headers: openaiHeaders(req.apiKey),
          body,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (!isOk(res.status)) {
          throw mapError(res.status, res.body, res.headers, req.model);
        }
        // A refusal or a truncation is settled: asking again costs the user
        // money for the same answer.
        const blocked = blockedReason(res.body);
        if (blocked !== null) {
          throw new AiError("bad_output", blocked, { provider: PROVIDER });
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
