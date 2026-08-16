import { Router } from "express";
import type { NextFunction, Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth/tokens.js";
import { allDestinations } from "../data/index.js";
import { cacheKey, getCached, putCached } from "../ai/cache.js";
import { loadUserKey, type AiRequest } from "../ai/loadUserKey.js";
import { inFlight } from "../ai/inflight.js";
import { findOwnedTrip, syncTripPacking } from "../ai/packingStore.js";
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

/**
 * One message for every way a tripId can be wrong — malformed, someone else's,
 * or the caller's own but for different dates. An attacker must not be able to
 * tell "that trip is not yours" from "that is not a trip id" by reading the
 * response, so the three cases are indistinguishable on the wire.
 */
const BAD_TRIP_ID = "tripId must be one of your own trips for these dates";
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
  /** Present only when the caller named one; the trip is resolved either way. */
  readonly tripId?: number;
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
  // The span is bounded but the epoch was not, so "0001-01-01" was a valid,
  // cacheable request. Nothing useful lives outside a planning horizon, and
  // bounding it shrinks the key space one caller can mint — which is what the
  // shared eviction budget is exposed to.
  const startYear = Number(start.slice(0, 4));
  const thisYear = new Date().getUTCFullYear();
  if (startYear < thisYear - 1 || startYear > thisYear + 2) {
    return { ok: false, message: "start must be within a year or two of today" };
  }

  // Required, never defaulted. Defaulting to "flight" would hand a rider a list
  // built around cabin liquid limits and lost checked baggage — the exact
  // failure this feature exists to prevent — and would cache it under a key
  // saying "bike".
  if (!isTravelMode(raw.mode)) {
    return { ok: false, message: `mode must be one of ${MODES.join(", ")}` };
  }

  // Shape only. Ownership *and* the tuple match are one lookup in the handler,
  // via findOwnedTrip — two separate checks would let a caller pass ownership
  // and then be silently ignored for naming a trip on other dates.
  const tripId = raw.tripId;
  if (
    tripId !== undefined &&
    (typeof tripId !== "number" || !Number.isSafeInteger(tripId) || tripId < 1)
  ) {
    return { ok: false, message: BAD_TRIP_ID };
  }

  return {
    ok: true,
    value: {
      dest,
      start,
      end,
      mode: raw.mode,
      ...(tripId === undefined ? {} : { tripId: tripId as number }),
    },
  };
}

/**
 * Every failure on this route is otherwise silent: `sendAiError` writes the
 * response and drops the cause, so a catalogue data bug and a vendor outage are
 * the same anonymous 502 to an operator.
 *
 * What is logged is deliberately narrow — a stage, a destination id, and the
 * error's class or `AiError` code. Never the cause chain, never the message of
 * an arbitrary throwable, never anything derived from the request body. An
 * upstream error object can carry the request that produced it, headers and
 * `Authorization` and all, which is exactly how a key reaches a log file.
 */
function logRouteFault(stage: string, destinationId: string, err: unknown): void {
  const code = err instanceof AiError ? err.code : (err as Error)?.name;
  console.error(
    `ai-packing: ${stage} failed for ${destinationId} (${code ?? "unknown"})`,
  );
}

/**
 * Mirrors the list into `trip_packing` and returns the tick state to spread
 * onto the response, or `{}` when no saved trip matches.
 *
 * It runs on the cache-**hit** path as well as the miss path, which is the
 * part worth stating: a user who saves the trip after generating the list, or
 * who generated it before the trip existed, still gets their checkboxes on the
 * next request without paying for a second completion.
 *
 * The tick state is assembled *here*, after `putCached`, and never becomes part
 * of the payload. `ai_cache` is global — a `checked` flag in a cached row would
 * be one user's private state served to a stranger.
 */
function tripStateFor(
  trip: { id: number } | null,
  userId: number,
  list: PackingList,
  destinationId: string,
): { trip?: { id: number; checked: Record<string, boolean>; checkedCount: number; total: number } } {
  if (!trip) return {};
  try {
    const state = syncTripPacking(trip.id, userId, list);
    // null means the trip vanished during the vendor call. Same shape as "no
    // trip saved", which the client already renders as disabled checkboxes.
    return state ? { trip: { id: trip.id, ...state } } : {};
  } catch (err) {
    // A storage fault here must not cost the user the answer they have already
    // paid for. Degrading to "no trip" keeps the list, and because the sync
    // also runs on the cache-hit path, the checkboxes reappear on the next
    // request for free rather than needing a second completion.
    logRouteFault("sync", destinationId, err);
    return {};
  }
}

export const aiPackingRouter = Router();

/**
 * The throttle is its own middleware, and its position is the point: it sits
 * *between* `requireAuth` and `loadUserKey`, not inside the handler.
 *
 * `loadUserKey` decrypts a stored key, which is a scrypt derivation —
 * ~60–90 ms on a libuv thread at 64 MB. `vault.ts` memoises by salt but caps
 * at 64 entries, and every saved key has its own salt. Registration is not
 * throttled, so with the limiter behind the key load an attacker registers
 * seventy accounts, saves one real key on each, and round-robins empty-bodied
 * requests: every one misses the derive cache, four concurrent saturate the
 * default threadpool, and none of it needs a valid body or costs them a cent.
 * In front of the key load, that budget is spent before any scrypt runs.
 */
function throttlePacking(req: AuthedRequest, res: Response, next: NextFunction): void {
  const decision = packingLimiter.check(`packing:${req.userId as number}`);
  if (decision.allowed) {
    next();
    return;
  }
  // Counts every request, not every generation: a rejected or cached request is
  // indistinguishable from a script's warm-up on its way to a paid one, so it
  // has to cost budget too. Spend is bounded a fortiori, since spend ⊆ requests.
  sendAiError(
    res,
    new AiError(
      "rate_limited",
      `too many packing requests — try again in ${decision.retryAfter}s`,
      { retryAfter: decision.retryAfter },
    ),
  );
}

// `aiKeysRouter` already mounts `requireAuth` on `/api/ai` and is registered
// first, so it runs twice for this path. It is idempotent, and mounting it here
// explicitly keeps this file self-contained rather than correct only by virtue
// of another router's position in `createApp`.
aiPackingRouter.use(
  "/api/ai/packing",
  requireAuth,
  throttlePacking,
  loadUserKey,
);

/**
 * Express 4 does not consume a handler's returned promise, so a rejection is an
 * *unhandled* rejection — under Node 20's default that terminates the process,
 * and the client meanwhile gets no response at all. `loadUserKey` guards against
 * exactly this and says so; this route has to as well.
 *
 * The throws are not hypothetical. `getCached` runs `JSON.parse` over a stored
 * row, so a payload that is not valid JSON is neither a miss nor a 502 but a
 * hang plus a crash. And every better-sqlite3 call here can raise `SQLITE_BUSY`
 * or `SQLITE_IOERR` — an operational reality with a file database in WAL and any
 * second writer, such as an overlapping deploy.
 *
 * So the whole handler is wrapped, and every throw reaches `sendAiError`, which
 * scrubs anything that is not an `AiError` down to a fixed string. No stack, no
 * message, no path on the wire.
 */
aiPackingRouter.post("/api/ai/packing", (req: AiRequest, res) => {
  void handlePacking(req, res).catch((err: unknown) => {
    if (!res.headersSent) sendAiError(res, err);
  });
});

async function handlePacking(req: AiRequest, res: Response): Promise<void> {
  const userId = req.userId as number; // requireAuth guarantees this
  const ai = req.ai as NonNullable<AiRequest["ai"]>; // loadUserKey guarantees this

  const parsed = parsePackingRequest(req.body);
  if (!parsed.ok) {
    sendLocalError(res, 400, "bad_request", parsed.message);
    return;
  }
  const { dest, start, end, mode, tripId } = parsed.value;

  // Resolved from the tuple the caller already sent, so no trip id has to be
  // trusted. Not finding one is not an error: generating a list for dates the
  // user has not saved is legitimate, and the response simply omits `trip`,
  // which is what tells the client to render the checkboxes disabled.
  const trip = findOwnedTrip({ userId, destinationId: dest.id, start, end, mode, tripId });
  // Naming a trip and being silently ignored is worse than being refused: the
  // client asked to tick against that trip and would get a list with no
  // checkboxes and no reason why. Absent tripId stays permissive — resolving
  // nothing there just means the user has not saved these dates.
  if (tripId !== undefined && !trip) {
    sendLocalError(res, 400, "bad_request", BAD_TRIP_ID);
    return;
  }

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
      // Already ISO-8601 with a zone marker — getCached normalises it.
      generatedAt = entry.createdAt;
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
      res.json({
        cached: true,
        generatedAt,
        packing: list,
        ...tripStateFor(trip, userId, list, dest.id),
      });
      return;
    }
  }

  try {
    // `req.ai` reaches `complete()` and nothing else — not a log line, not the
    // cached payload, not the response.
    // Keyed on the cache key, which already carries everything that changes
    // the answer including the provider and model — so two users who ask the
    // same question inside the vendor's latency window share one paid call
    // instead of buying the same answer twice. The apiKey is deliberately NOT
    // part of the key: the answer does not depend on whose credential bought
    // it, and including it would defeat the whole point while putting a
    // credential in a map key.
    const result = await inFlight(key, () =>
      ai.provider.complete({
        apiKey: ai.apiKey,
        model: ai.model,
        system: packingSystemPrompt(),
        user: packingUserPrompt(buildGrounding(dest, start, end, mode)),
        schema: PACKING_SCHEMA,
        schemaName: PACKING_SCHEMA_NAME,
        parse: makePackingParser(mode),
        maxTokens: 3000,
        temperature: 0.4,
      }),
    );

    // Persisting is deliberately *after* the answer exists and deliberately not
    // allowed to lose it. The completion is already paid for; failing the
    // request because a cache write hit a locked database would charge the user
    // and hand them a 502 blaming the vendor for our storage fault.
    // Two separate guards, not one. Sharing a try meant a SQLITE_BUSY on the
    // cache write silently dropped the billing record for a completion the
    // user had genuinely paid for — the accounting would then under-report
    // exactly the calls that cost money.
    try {
      putCached(key, "packing", result.data, { keep: PACKING_CACHE_LIMIT });
    } catch (err) {
      logRouteFault("cache-write", dest.id, err);
    }
    try {
      recordUsage({
        userId,
        feature: "packing",
        provider: ai.providerId,
        model: ai.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cached: false,
      });
    } catch (err) {
      logRouteFault("usage", dest.id, err);
    }

    res.json({
      cached: false,
      generatedAt: new Date().toISOString(),
      packing: result.data,
      ...tripStateFor(trip, userId, result.data, dest.id),
    });
  } catch (err) {
    // The single place an AI route writes an error response: it maps the code to
    // a status, sets Retry-After, and scrubs the message of anything that is not
    // an AiError — an arbitrary throwable can carry the request that produced it.
    logRouteFault("complete", dest.id, err);
    sendAiError(res, err);
  }
}
