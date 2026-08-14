import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth/tokens.js";
import {
  deleteKey,
  listKeys,
  saveKey,
  setPreferred,
} from "../ai/keystore.js";
import {
  AiError,
  PROVIDER_IDS,
  sendAiError,
  type ProviderId,
} from "../ai/provider.js";
import { getProvider } from "../ai/registry.js";
import { createRateLimiter } from "../ai/rateLimit.js";
import { usageSummary, usageTotals } from "../ai/usage.js";

/**
 * Ten saves an hour per account. A save derives a scrypt key and then makes a
 * live call to a vendor with whatever credential was pasted — so without a
 * limit this route is both a way to soak the server's CPU and a free oracle for
 * testing stolen API keys against three vendors. Ten is far above what a real
 * user needs (they save a key once, maybe re-paste it after a typo) and far
 * below what a script wants.
 */
const SAVE_LIMIT = 10;
const SAVE_WINDOW_MS = 60 * 60 * 1000;
const saveLimiter = createRateLimiter({
  limit: SAVE_LIMIT,
  windowMs: SAVE_WINDOW_MS,
});

/** Test-only: the limiter is module state shared by every test in a file. */
export function __resetSaveLimitForTests(): void {
  saveLimiter.reset();
}

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

  // Counted before any validation: a rejected attempt is exactly what an
  // oracle probe looks like, so it has to cost the caller budget too.
  const limit = saveLimiter.check(`save:${userId}`);
  if (!limit.allowed) {
    sendAiError(
      res,
      new AiError(
        "rate_limited",
        `too many key saves — try again in ${limit.retryAfter}s`,
        { retryAfter: limit.retryAfter },
      ),
    );
    return;
  }

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
    const key = await saveKey({
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

/**
 * What the user has spent, scoped to them. Empty until F1 ships — an empty
 * array is the correct answer for someone who has made no AI calls, not a
 * broken one.
 */
aiKeysRouter.get("/api/ai/usage", (req: AuthedRequest, res) => {
  const usage = usageSummary(req.userId as number);
  res.json({ usage, totals: usageTotals(usage) });
});

/**
 * Changing which provider is the default without re-pasting the key. Forcing a
 * re-paste to flip a preference would be a dark pattern, and the key is the one
 * thing the user cannot read back to check.
 */
aiKeysRouter.put("/api/ai/keys/preferred", (req: AuthedRequest, res) => {
  const provider = req.body?.provider;
  if (!isProviderId(provider)) {
    sendLocalError(
      res,
      400,
      "bad_request",
      `provider must be one of ${PROVIDER_IDS.join(", ")}`,
    );
    return;
  }
  const userId = req.userId as number;
  if (!setPreferred(userId, provider)) {
    sendLocalError(res, 404, "not_found", "no key configured for that provider");
    return;
  }
  res.json({ keys: listKeys(userId) });
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
