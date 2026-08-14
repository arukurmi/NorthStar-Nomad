import { ApiError, type AuthState } from "./auth";
import type {
  AiErrorCode,
  AiKeyPublic,
  KeysResponse,
  ProviderId,
  SaveKeyResponse,
  UsageResponse,
} from "./types";

/**
 * A failed `/api/ai/*` call, carrying the server's machine-readable `code`.
 *
 * Components branch on `code` and never on a status number or a message
 * substring — the whole point of the taxonomy is that `401 unauthenticated`
 * (session gone) and `401 invalid_key` (provider said no) are told apart
 * without guessing.
 */
export class AiClientError extends Error {
  readonly code: AiErrorCode;
  readonly provider?: ProviderId;
  /** Seconds to wait. Only present for `rate_limited`. */
  readonly retryAfter?: number;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { provider?: ProviderId; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "AiClientError";
    this.code = code;
    this.provider = opts.provider;
    this.retryAfter = opts.retryAfter;
  }
}

const KNOWN_CODES: readonly AiErrorCode[] = [
  "unauthenticated",
  "bad_request",
  "not_found",
  "no_key",
  "invalid_key",
  "insufficient_credit",
  "rate_limited",
  "provider_error",
  "bad_output",
];

function isAiErrorCode(value: unknown): value is AiErrorCode {
  return (
    typeof value === "string" && (KNOWN_CODES as readonly string[]).includes(value)
  );
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "anthropic" || value === "gemini" || value === "openai"
  );
}

/**
 * Normalises anything thrown out of `authFetch` into an `AiClientError`.
 * A dropped connection has no server body at all, so it becomes
 * `provider_error` — the code that means "try again in a moment".
 */
function toAiError(err: unknown): AiClientError {
  if (err instanceof AiClientError) return err;
  if (err instanceof ApiError) {
    return new AiClientError(
      isAiErrorCode(err.code) ? err.code : "provider_error",
      err.message,
      {
        provider: isProviderId(err.provider) ? err.provider : undefined,
        retryAfter: err.retryAfter,
      },
    );
  }
  return new AiClientError(
    "provider_error",
    err instanceof Error ? err.message : "the request could not be completed",
  );
}

export interface SaveKeyInput {
  provider: ProviderId;
  /**
   * Plaintext. It exists for exactly the length of this call: it is not
   * stored, not logged, not put in a URL, and not held anywhere afterwards.
   */
  apiKey: string;
  model?: string;
  preferred?: boolean;
}

export interface AiClient {
  listKeys(): Promise<AiKeyPublic[]>;
  saveKey(input: SaveKeyInput): Promise<AiKeyPublic>;
  deleteKey(provider: ProviderId): Promise<void>;
  setPreferred(provider: ProviderId): Promise<AiKeyPublic[]>;
  usage(): Promise<UsageResponse>;
}

/**
 * Built from the auth context's `authFetch` so there is exactly one place the
 * bearer token comes from.
 */
export function createAiClient(authFetch: AuthState["authFetch"]): AiClient {
  return {
    async listKeys() {
      try {
        const { keys } = await authFetch<KeysResponse>("/api/ai/keys");
        return keys;
      } catch (err) {
        throw toAiError(err);
      }
    },

    async saveKey(input) {
      // A "copy" button in a provider console routinely hands over a trailing
      // newline, and a wrapped terminal paste hands over internal ones. No
      // real key contains whitespace, so stripping it here turns the single
      // most common failure into a success instead of a mystery 400.
      const apiKey = input.apiKey.replace(/\s+/g, "");
      const body: Record<string, unknown> = {
        provider: input.provider,
        apiKey,
      };
      if (input.model) body.model = input.model;
      if (input.preferred !== undefined) body.preferred = input.preferred;

      try {
        // signOutOn401: this route answers 401 for a rejected *API key* as
        // well as for a dead session. Letting the default fire would sign the
        // user out of Northstar Nomad for a typo.
        const { key } = await authFetch<SaveKeyResponse>(
          "/api/ai/keys",
          { method: "POST", body: JSON.stringify(body) },
          { signOutOn401: false },
        );
        return key;
      } catch (err) {
        throw toAiError(err);
      }
    },

    async deleteKey(provider) {
      try {
        await authFetch<void>(`/api/ai/keys/${provider}`, { method: "DELETE" });
      } catch (err) {
        throw toAiError(err);
      }
    },

    async setPreferred(provider) {
      try {
        const { keys } = await authFetch<KeysResponse>(
          "/api/ai/keys/preferred",
          { method: "PUT", body: JSON.stringify({ provider }) },
        );
        return keys;
      } catch (err) {
        throw toAiError(err);
      }
    },

    async usage() {
      try {
        return await authFetch<UsageResponse>("/api/ai/usage");
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}

export interface ProviderMeta {
  /** Human name, e.g. "Anthropic Claude". */
  label: string;
  /** Short mark for the gradient chip — no image assets anywhere in this app. */
  initials: string;
  defaultModel: string;
  /** CSS gradient, applied inline exactly like `Destination.heroGradient`. */
  gradient: string;
  /** What a valid key looks like, shown under the input. */
  keyHint: string;
  /** Where the user goes to create one. */
  consoleUrl: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    label: "Anthropic Claude",
    initials: "AN",
    defaultModel: "claude-sonnet-5",
    gradient: "linear-gradient(135deg, #d97757 0%, #f0a06a 60%, #ffd9a0 100%)",
    keyHint: "starts with sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    label: "Google Gemini",
    initials: "GE",
    defaultModel: "gemini-2.5-pro",
    gradient: "linear-gradient(135deg, #4285f4 0%, #9b72cb 55%, #d96570 100%)",
    keyHint: "starts with AIza",
    consoleUrl: "https://aistudio.google.com/app/apikey",
  },
  openai: {
    label: "OpenAI",
    initials: "OA",
    defaultModel: "gpt-5",
    gradient: "linear-gradient(135deg, #10a37f 0%, #3ec9a7 55%, #7aa7ff 100%)",
    keyHint: "starts with sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
};

/**
 * `claude-sonnet-5` → `Claude Sonnet 5`. Model ids are the vendor's identifier
 * and belong in the meta line verbatim; this is for the human-facing pill.
 */
export function formatModel(model: string): string {
  return model
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) =>
      /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}
