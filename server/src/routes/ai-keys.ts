import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth/tokens.js";
import { deleteKey, listKeys, saveKey } from "../ai/keystore.js";
import {
  AiError,
  PROVIDER_IDS,
  sendAiError,
  type ProviderId,
} from "../ai/provider.js";
import { getProvider } from "../ai/registry.js";

/**
 * Deliberately loose — prefix, character class, length floor — and centralised
 * in one constant so a vendor prefix change is a one-line fix rather than a
 * hunt. An exact-length regex would break every user's save the day a vendor
 * lengthens its keys.
 */
const KEY_SHAPE: Record<ProviderId, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
  gemini: /^AIza[A-Za-z0-9_-]{30,}$/,
};

const MODEL_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_KEY_LENGTH = 500;

/**
 * The non-provider half of the error taxonomy. Provider failures go through
 * `sendAiError` so they carry `Retry-After`; these are our own rejections.
 */
type LocalErrorCode = "bad_request" | "not_found";

function sendLocalError(
  res: Response,
  status: number,
  code: LocalErrorCode,
  error: string,
): void {
  res.status(status).json({ error, code });
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export const aiKeysRouter = Router();

// Every AI route is per-user: authentication required, and every statement is
// scoped by user_id, so another user's key is a 404 rather than a leak.
aiKeysRouter.use("/api/ai", requireAuth);

aiKeysRouter.post("/api/ai/keys", async (req: AuthedRequest, res) => {
  const userId = req.userId as number; // requireAuth guarantees this
  const { provider, model, preferred } = req.body ?? {};

  if (!isProviderId(provider)) {
    sendLocalError(
      res,
      400,
      "bad_request",
      `provider must be one of ${PROVIDER_IDS.join(", ")}`,
    );
    return;
  }

  const rawKey: unknown = req.body?.apiKey;
  if (typeof rawKey !== "string") {
    sendLocalError(res, 400, "bad_request", "apiKey is required");
    return;
  }
  // Trim first: a console "copy" button routinely appends a newline, and
  // without this every such paste fails for a reason the user cannot see.
  const apiKey = rawKey.trim();
  if (
    apiKey.length > MAX_KEY_LENGTH ||
    /\s/.test(apiKey) ||
    !KEY_SHAPE[provider].test(apiKey)
  ) {
    // The rejected value is never echoed back — it is a credential.
    sendLocalError(
      res,
      400,
      "bad_request",
      `that does not look like a ${provider} API key`,
    );
    return;
  }

  const adapter = getProvider(provider);
  const resolvedModel =
    model === undefined || model === null ? adapter.defaultModel : model;
  if (typeof resolvedModel !== "string" || !MODEL_SHAPE.test(resolvedModel)) {
    sendLocalError(res, 400, "bad_request", "model is not a valid model id");
    return;
  }

  try {
    const result = await adapter.validate(apiKey, resolvedModel);
    if (!result.ok) {
      // Routed through AiError so rate_limited gets its Retry-After header
      // from the one place that writes AI error responses.
      sendAiError(
        res,
        new AiError(result.code, result.message, {
          provider,
          retryAfter: result.retryAfter,
        }),
      );
      return;
    }

    // Nothing is written until the provider has confirmed the credential.
    const key = saveKey({
      userId,
      provider,
      apiKey,
      model: resolvedModel,
      validatedAt: new Date().toISOString(),
      preferred: preferred === true,
    });
    res.json({ key });
  } catch (err) {
    sendAiError(res, err);
  }
});

aiKeysRouter.get("/api/ai/keys", (req: AuthedRequest, res) => {
  res.json({ keys: listKeys(req.userId as number) });
});

aiKeysRouter.delete("/api/ai/keys/:provider", (req: AuthedRequest, res) => {
  const provider = req.params.provider;
  if (!isProviderId(provider)) {
    sendLocalError(
      res,
      400,
      "bad_request",
      `provider must be one of ${PROVIDER_IDS.join(", ")}`,
    );
    return;
  }
  // Scoped by user_id, so deleting someone else's key is indistinguishable
  // from deleting one that was never configured — no existence oracle.
  if (!deleteKey(req.userId as number, provider)) {
    sendLocalError(res, 404, "not_found", "no key configured for that provider");
    return;
  }
  res.status(204).end();
});
