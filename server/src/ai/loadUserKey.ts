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
 *
 * Exported synchronously because Express 4 does not await a middleware: the
 * async work is wrapped so a rejection becomes a response rather than an
 * unhandled rejection that hangs the request.
 */
export function loadUserKey(
  req: AiRequest,
  res: Response,
  next: NextFunction,
): void {
  void selectForRequest(req, res, next).catch((err: unknown) => {
    if (!res.headersSent) sendAiError(res, err);
  });
}

async function selectForRequest(
  req: AiRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const asked: unknown = req.body?.provider ?? req.query?.provider;
  // A provider param that is present but not a provider id is a mistake, not
  // an absence of preference. Treating it as "no preference" would silently
  // serve `?provider=OpenAI` from whichever vendor happens to be the default
  // and bill the wrong account's key.
  if (asked !== undefined && !isProviderId(asked)) {
    res.status(400).json({
      error: `provider must be one of ${PROVIDER_IDS.join(", ")}`,
      code: "bad_request",
    });
    return;
  }
  const prefer = isProviderId(asked) ? asked : undefined;

  let key;
  try {
    key = await selectKey(req.userId as number, prefer);
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
