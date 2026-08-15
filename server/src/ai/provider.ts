import type { Response } from "express";

export type ProviderId = "anthropic" | "gemini" | "openai";
export const PROVIDER_IDS = ["anthropic", "gemini", "openai"] as const;

export type AiFeature = "itinerary" | "packing" | "budget" | "search";

/** JSON Schema subset every vendor can express. Deliberately narrow. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
}

export type JsonSchemaNode =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | {
      type: "number" | "integer";
      description?: string;
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean"; description?: string }
  | {
      type: "array";
      description?: string;
      items: JsonSchemaNode;
      minItems?: number;
      maxItems?: number;
    }
  | JsonSchemaObject;

export interface CompletionRequest<T> {
  /** Plaintext key. Lives only for the duration of the call. Never logged. */
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** Vendor-agnostic schema; each adapter translates it. */
  schema: JsonSchemaObject;
  /** Name the vendor attaches to the schema/tool. `[a-z0-9_]{1,40}`. */
  schemaName: string;
  /**
   * Runtime validator. Throws to signal a schema violation. This is what makes
   * `T` inferable — no zod, no new dependency — and it is what the adapter
   * re-runs after its single retry before giving up with `bad_output`.
   */
  parse: (value: unknown) => T;
  maxTokens?: number; // default 4096
  temperature?: number; // default 0.4; omitted for models that reject it
  timeoutMs?: number; // default 45_000
}

export interface CompletionResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the adapter needed its one retry to get valid JSON. */
  retried: boolean;
}

export type ValidationResult =
  | { ok: true; model: string; detail?: string }
  | { ok: false; code: AiErrorCode; message: string; retryAfter?: number };

export interface AiProvider {
  readonly id: ProviderId;
  readonly defaultModel: string;
  /** Cheapest possible call that proves the key works. */
  validate(apiKey: string, model?: string): Promise<ValidationResult>;
  /** Single-turn structured generation against a JSON schema. */
  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;
}

export type AiErrorCode =
  | "no_key"
  | "invalid_key"
  | "insufficient_credit"
  | "rate_limited"
  | "provider_error"
  | "bad_output";

export const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  no_key: 428,
  invalid_key: 401,
  insufficient_credit: 402,
  rate_limited: 429,
  provider_error: 502,
  bad_output: 502,
};

export interface AiErrorBody {
  error: string; // human-facing, safe to render verbatim
  code: AiErrorCode;
  provider?: ProviderId;
  retryAfter?: number; // seconds; only for rate_limited
}

/**
 * The message a non-AiError throwable is replaced with. An arbitrary throwable
 * may carry a request body, a header, or a stack — any of which could hold a
 * plaintext API key — so its message never reaches the wire.
 */
const SCRUBBED_MESSAGE = "the AI provider could not be reached";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  readonly provider?: ProviderId;
  readonly retryAfter?: number;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { provider?: ProviderId; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AiError";
    this.code = code;
    this.status = AI_ERROR_STATUS[code];
    this.provider = opts.provider;
    this.retryAfter = opts.retryAfter;
  }

  /** Exactly what goes on the wire. Never includes `cause` or a stack. */
  toJSON(): AiErrorBody {
    const body: AiErrorBody = { error: this.message, code: this.code };
    if (this.provider !== undefined) body.provider = this.provider;
    if (this.retryAfter !== undefined) body.retryAfter = this.retryAfter;
    return body;
  }

  /** Non-AiError → provider_error, with the original message scrubbed. */
  static from(err: unknown): AiError {
    if (err instanceof AiError) return err;
    return new AiError("provider_error", SCRUBBED_MESSAGE, { cause: err });
  }
}

/** The single place any AI route writes an error response. */
export function sendAiError(res: Response, err: unknown): void {
  const aiError = AiError.from(err);
  if (aiError.retryAfter !== undefined) {
    res.set("Retry-After", String(aiError.retryAfter));
  }
  res.status(aiError.status).json(aiError.toJSON());
}
