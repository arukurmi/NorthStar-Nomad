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

const PROVIDER: ProviderId = "anthropic";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const VALIDATE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.4;
const RATE_LIMIT_FALLBACK_SECONDS = 30;

/**
 * The key travels in a header, and this object is never logged — `http.ts`
 * logs nothing at all, precisely because this value passes through it.
 */
function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

/**
 * Vendor error text is read only to *classify* the failure — it is never
 * surfaced. Anthropic has echoed request fragments back in `message` before,
 * and a request fragment can carry the `x-api-key` header, so every message
 * this module throws is written here rather than taken from the body.
 */
function vendorError(body: unknown): { type: string; message: string } {
  const error = (body as { error?: { type?: unknown; message?: unknown } } | null)
    ?.error;
  return {
    type: typeof error?.type === "string" ? error.type : "",
    message: typeof error?.message === "string" ? error.message : "",
  };
}

function retryAfterHeader(headers: Headers, fallback: number): number {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Anthropic status/`error.type` → the shared six-code taxonomy. */
export function mapError(
  status: number,
  body: unknown,
  headers: Headers,
  model?: string,
): AiError {
  const { type, message } = vendorError(body);
  const opts = { provider: PROVIDER };

  if (status === 401 || type === "authentication_error") {
    return new AiError("invalid_key", "Anthropic rejected this API key", opts);
  }
  if (status === 403 || type === "permission_error") {
    return new AiError(
      "invalid_key",
      "this Anthropic key is not permitted to use the Messages API",
      opts,
    );
  }
  if (status === 429) {
    return new AiError("rate_limited", "Anthropic is rate limiting this key", {
      ...opts,
      retryAfter: retryAfterHeader(headers, RATE_LIMIT_FALLBACK_SECONDS),
    });
  }
  if (status === 529 || type === "overloaded_error") {
    return new AiError("provider_error", "Anthropic is overloaded — try again shortly", {
      ...opts,
      retryAfter: RATE_LIMIT_FALLBACK_SECONDS,
    });
  }
  if (status === 400) {
    if (/credit balance is too low/i.test(message)) {
      return new AiError(
        "insufficient_credit",
        "this Anthropic account is out of credit — top it up to continue",
        opts,
      );
    }
    return new AiError("provider_error", "Anthropic rejected the request", opts);
  }
  if (status === 404) {
    const named = model === undefined ? "that model" : `model ${model}`;
    return new AiError(
      "provider_error",
      `${named} is not available on your account`,
      opts,
    );
  }
  return new AiError("provider_error", "Anthropic returned an error", opts);
}

/**
 * Identity. Anthropic's `input_schema` takes plain JSON Schema, so the internal
 * shape passes straight through — the seam exists so every adapter has the same
 * four pure functions, not because this vendor needs a transform.
 */
export function toVendorSchema(schema: JsonSchemaObject): unknown {
  return schema;
}

/**
 * Forced tool use is the structured-output mechanism, so the payload is the
 * `input` of the tool_use block — already parsed, unlike the other two vendors.
 */
export function extractJson(body: unknown, schemaName?: string): unknown {
  const content = (body as { content?: unknown } | null)?.content;
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use") continue;
    if (schemaName !== undefined && b.name !== schemaName) continue;
    return b.input;
  }
  throw new AiError(
    "bad_output",
    "Anthropic answered without using the requested tool",
    { provider: PROVIDER },
  );
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function extractUsage(body: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)
    ?.usage;
  return {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
  };
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A parse throw carries the caller's own message; it is replaced, not surfaced. */
function badOutput(err: unknown): AiError {
  if (err instanceof AiError && err.code === "bad_output") return err;
  return new AiError(
    "bad_output",
    "Anthropic's answer did not match the expected schema",
    { provider: PROVIDER, cause: err },
  );
}

export interface AnthropicOptions {
  /** Injected in tests; production gets the real `requestJson`. */
  transport?: RequestJson;
}

export function createAnthropicProvider(
  options: AnthropicOptions = {},
): AiProvider {
  const transport = options.transport ?? requestJson;

  return {
    id: PROVIDER,
    defaultModel: ANTHROPIC_DEFAULT_MODEL,

    async validate(apiKey: string, model?: string): Promise<ValidationResult> {
      const chosen = model ?? ANTHROPIC_DEFAULT_MODEL;
      try {
        // Anthropic has no free credential-check endpoint, so this is the
        // floor: one input token in, one out.
        const res = await transport({
          url: MESSAGES_URL,
          method: "POST",
          headers: anthropicHeaders(apiKey),
          body: {
            model: chosen,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          },
          timeoutMs: VALIDATE_TIMEOUT_MS,
        });
        // A 200 that stopped at max_tokens still proves the key works.
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
      const body = {
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: req.schemaName,
            description: "Return the result using this schema.",
            input_schema: toVendorSchema(req.schema),
          },
        ],
        tool_choice: { type: "tool", name: req.schemaName },
      };

      let lastFailure: unknown;
      // One retry, and one only: a malformed answer is usually a sampling
      // accident, and a second failure is a real schema disagreement.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await transport({
          url: MESSAGES_URL,
          method: "POST",
          headers: anthropicHeaders(req.apiKey),
          body,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (!isOk(res.status)) {
          throw mapError(res.status, res.body, res.headers, req.model);
        }
        try {
          const data = req.parse(extractJson(res.body, req.schemaName));
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
