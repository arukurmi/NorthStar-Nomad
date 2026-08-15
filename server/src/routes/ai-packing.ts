import { Router } from "express";
import type { Response } from "express";
import { requireAuth } from "../auth/tokens.js";
import { allDestinations } from "../data/index.js";
import { cacheKey, getCached, putCached } from "../ai/cache.js";
import { loadUserKey, type AiRequest } from "../ai/loadUserKey.js";
import {
  makePackingParser,
  parsePackingList,
  PACKING_SCHEMA,
  PACKING_SCHEMA_NAME,
  type PackingList,
} from "../ai/packing.js";
import {
  buildGrounding,
  packingSystemPrompt,
  packingUserPrompt,
  MAX_SPAN_DAYS,
  PACKING_CACHE_LIMIT,
  PACKING_MAX_AGE_MS,
  PACKING_PROMPT_VERSION,
} from "../ai/prompts/packing.js";
import { AiError, sendAiError } from "../ai/provider.js";
import { createRateLimiter } from "../ai/rateLimit.js";
import { recordUsage } from "../ai/usage.js";
import type { Destination, TravelMode } from "../types.js";

/**
 * Thirty generations an hour per account. THREAT-MODEL §4 records "spend the
 * victim's provider credit through our features" as an accepted F0 risk *on the
 * grounds that F1–F4 did not exist yet* — there was simply nothing to spend the
 * key on. This route is the first thing that makes it real, so the acceptance
 * lapses with it. Thirty bounds the burn a stolen token can cause without being
 * a spend cap: a real user generates a handful of lists while planning, and even
 * pathological re-planning stays far below it, while a script pointed at the
 * endpoint stops costing money after half a minute of work.
 */
const PACKING_LIMIT = 30;
const PACKING_WINDOW_MS = 60 * 60 * 1000;
const packingLimiter = createRateLimiter({
  limit: PACKING_LIMIT,
  windowMs: PACKING_WINDOW_MS,
});

/** Test-only: the limiter is module state shared by every test in a file. */
export function __resetPackingLimitForTests(): void {
  packingLimiter.reset();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ["flight", "bike", "bus"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The non-provider half of the error taxonomy. Provider failures go through
 * `sendAiError` so they carry `Retry-After`; these are our own rejections.
 */
type LocalErrorCode = "bad_request";

function sendLocalError(
  res: Response,
  status: number,
  code: LocalErrorCode,
  error: string,
): void {
  res.status(status).json({ error, code });
}

function isTravelMode(value: unknown): value is TravelMode {
  return (
    typeof value === "string" && (MODES as readonly string[]).includes(value)
  );
}

/**
 * A real calendar date, not merely a well-shaped string. The regex alone is not
 * enough and the gap is surprising: V8 reads "2026-02-30T00:00:00Z" as 2 March
 * rather than rejecting it, so a February request would be grounded, answered
 * and cached against March's weather — a wrong answer rather than a loud one.
 * Round-tripping through `toISOString` is the cheap way to tell a real date from
 * one that rolled over.
 */
function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
  );
}

interface PackingRequestFields {
  readonly dest: Destination;
  readonly start: string;
  readonly end: string;
  readonly mode: TravelMode;
}

type PackingRequestParse =
  | { readonly ok: true; readonly value: PackingRequestFields }
  | { readonly ok: false; readonly message: string };

/**
 * Every rejection message describes the *rule*, never the value that broke it.
 * The body of this route can carry a `provider` field and, through a caller's
 * mistake, anything else — echoing it back is how a credential ends up in a
 * screenshot or a log line.
 */
function parsePackingRequest(body: unknown): PackingRequestParse {
  const raw = (body ?? {}) as Record<string, unknown>;

  const dest = allDestinations.find((d) => d.id === raw.destinationId);
  if (!dest) {
    return { ok: false, message: "destinationId is not a known destination" };
  }

  if (!isRealDate(raw.start) || !isRealDate(raw.end)) {
    return { ok: false, message: "start and end must be real YYYY-MM-DD dates" };
  }
  const start = raw.start;
  const end = raw.end;
  if (start > end) {
    return { ok: false, message: "start must not be after end" };
  }
  // Inclusive: a 12th → 18th trip is 7 days, not 6. Both dates round-tripped
  // above, so the subtraction is over two real UTC midnights.
  const days =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      DAY_MS +
    1;
  if (days > MAX_SPAN_DAYS) {
    return { ok: false, message: `trips longer than ${MAX_SPAN_DAYS} days are not supported` };
  }

  // Required, never defaulted. Defaulting to "flight" would hand a rider a list
  // built around cabin liquid limits and lost checked baggage — the exact
  // failure this feature exists to prevent — and would cache it under a key
  // saying "bike".
  if (!isTravelMode(raw.mode)) {
    return { ok: false, message: `mode must be one of ${MODES.join(", ")}` };
  }

  // TODO(P03): Phase 03 resolves this to an owned trip matching the tuple and
  // syncs `trip_packing`. Validated here so a client that already sends it gets
  // a 400 rather than silent acceptance of a value nothing reads yet.
  const tripId = raw.tripId;
  if (
    tripId !== undefined &&
    (typeof tripId !== "number" || !Number.isSafeInteger(tripId) || tripId < 1)
  ) {
    return { ok: false, message: "tripId must be a positive integer" };
  }

  return { ok: true, value: { dest, start, end, mode: raw.mode } };
}

/**
 * `ai_cache.created_at` is `datetime('now')` output — "YYYY-MM-DD HH:MM:SS" in
 * UTC with **no zone marker** — which `new Date(...)` in a browser reads as
 * local time. Shipped raw, a list generated a minute ago reads as hours old
 * wherever the user is not on UTC. Throws on an unparseable value, which the
 * caller handles by treating the row as a miss.
 */
function toIsoTimestamp(stored: string): string {
  const at = stored.includes("T") ? stored : `${stored.replace(" ", "T")}Z`;
  return new Date(at).toISOString();
}

export const aiPackingRouter = Router();

// `aiKeysRouter` already mounts `requireAuth` on `/api/ai` and is registered
// first, so it runs twice for this path. It is idempotent, and mounting it here
// explicitly keeps this file self-contained rather than correct only by virtue
// of another router's position in `createApp`.
aiPackingRouter.use("/api/ai/packing", requireAuth, loadUserKey);

aiPackingRouter.post("/api/ai/packing", async (req: AiRequest, res) => {
  const userId = req.userId as number; // requireAuth guarantees this
  const ai = req.ai as NonNullable<AiRequest["ai"]>; // loadUserKey guarantees this

  // Checked before validation: a rejected request is exactly what a script
  // burning someone else's credit looks like on its way to a well-formed one,
  // so an attempt has to cost budget whether or not it was well-formed.
  const limit = packingLimiter.check(`packing:${userId}`);
  if (!limit.allowed) {
    sendAiError(
      res,
      new AiError(
        "rate_limited",
        `too many packing lists — try again in ${limit.retryAfter}s`,
        { retryAfter: limit.retryAfter },
      ),
    );
    return;
  }

  const parsed = parsePackingRequest(req.body);
  if (!parsed.ok) {
    sendLocalError(res, 400, "bad_request", parsed.message);
    return;
  }
  const { dest, start, end, mode } = parsed.value;

  const key = cacheKey({
    feature: "packing",
    destinationId: dest.id,
    start,
    end,
    mode,
    model: ai.model,
    provider: ai.providerId,
    options: { pv: PACKING_PROMPT_VERSION },
  });

  const entry = getCached<PackingList>(key, { maxAgeMs: PACKING_MAX_AGE_MS });
  if (entry) {
    // Re-validated rather than trusted, which answers a review finding: the row
    // was written by whoever happened to trigger the miss, and `ai_cache` is
    // global. A payload from a prompt version this build no longer understands,
    // or one edited straight into the SQLite file, would otherwise be served
    // with our UI's trust — checkboxes, item keys and all — attached to it.
    // A row that does not survive the parser is a miss, not a 502: the user
    // gets a correct list, paid for once, instead of an error page.
    let list: PackingList | null = null;
    let generatedAt = "";
    try {
      list = parsePackingList(entry.payload, mode);
      generatedAt = toIsoTimestamp(entry.createdAt);
    } catch {
      list = null;
    }
    if (list) {
      recordUsage({
        userId,
        feature: "packing",
        provider: ai.providerId,
        model: ai.model,
        inputTokens: 0,
        outputTokens: 0,
        cached: true,
      });
      res.json({ cached: true, generatedAt, packing: list });
      return;
    }
  }

  try {
    // `req.ai` reaches `complete()` and nothing else — not a log line, not the
    // cached payload, not the response.
    const result = await ai.provider.complete({
      apiKey: ai.apiKey,
      model: ai.model,
      system: packingSystemPrompt(),
      user: packingUserPrompt(buildGrounding(dest, start, end, mode)),
      schema: PACKING_SCHEMA,
      schemaName: PACKING_SCHEMA_NAME,
      parse: makePackingParser(mode),
      maxTokens: 3000,
      temperature: 0.4,
    });

    putCached(key, "packing", result.data, { keep: PACKING_CACHE_LIMIT });
    recordUsage({
      userId,
      feature: "packing",
      provider: ai.providerId,
      model: ai.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cached: false,
    });

    res.json({
      cached: false,
      generatedAt: new Date().toISOString(),
      packing: result.data,
    });
  } catch (err) {
    // The single place an AI route writes an error response: it maps the code to
    // a status, sets Retry-After, and scrubs the message of anything that is not
    // an AiError — an arbitrary throwable can carry the request that produced it.
    sendAiError(res, err);
  }
});
