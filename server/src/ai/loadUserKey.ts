import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../auth/tokens.js";
import { selectKey } from "./keystore.js";
import {
  AiError,
  PROVIDER_IDS,
  sendAiError,
  type AiProvider,
  type ProviderId,
} from "./provider.js";
import { getProvider } from "./registry.js";

export interface AiRequest extends AuthedRequest {
  /** Populated by loadUserKey. Contains PLAINTEXT — never serialise this. */
  ai?: {
    providerId: ProviderId;
    provider: AiProvider;
    apiKey: string;
    model: string;
  };
}

const NO_KEY_AT_ALL = "add an AI key in your profile to use this";

/**
 * Written out per provider rather than assembled from a label, because the
 * article changes ("an Anthropic", "a Gemini") and this string is user-facing.
 */
const NO_KEY_FOR: Record<ProviderId, string> = {
  anthropic: "you haven't added an Anthropic key yet",
  gemini: "you haven't added a Gemini key yet",
  openai: "you haven't added an OpenAI key yet",
};

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Selects a provider for this request, decrypts that key, and attaches it to
 * `req.ai`. Must run after `requireAuth` — it reads `req.userId`.
 *
 * Selection order is strict: an explicit provider on the request, then the
 * stored preference, then the most recently validated key.
 */
export function loadUserKey(
  req: AiRequest,
  res: Response,
  next: NextFunction,
): void {
  const asked: unknown = req.body?.provider ?? req.query?.provider;
  // Validated against the enum: a value that is not a provider id is not an
  // explicit preference, so it never reaches the keystore.
  const prefer = isProviderId(asked) ? asked : undefined;

  let key;
  try {
    key = selectKey(req.userId as number, prefer);
  } catch (err) {
    // selectKey raises provider_error, not invalid_key, for a blob that will
    // not decrypt: a 401 would sign the user out over a storage fault.
    sendAiError(res, err);
    return;
  }

  if (!key) {
    // A caller who named a provider is told about *that* provider and is never
    // silently handed a different one — they asked for a specific vendor.
    sendAiError(
      res,
      new AiError("no_key", prefer ? NO_KEY_FOR[prefer] : NO_KEY_AT_ALL, {
        provider: prefer,
      }),
    );
    return;
  }

  req.ai = {
    providerId: key.providerId,
    provider: getProvider(key.providerId),
    apiKey: key.apiKey,
    model: key.model,
  };
  next();
}
