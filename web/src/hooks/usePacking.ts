import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { AiClientError, createAiClient } from "../lib/ai";
import type {
  AiErrorCode,
  PackingList,
  PackingRequest,
  PackingTripState,
} from "../lib/types";

/**
 * Five states, and `idle` is the important one.
 *
 * There is no "generating on mount". Every call spends the user's own money,
 * so one call per explicit click is a product rule, not a performance choice —
 * opening a tab must never bill anyone. `idle` is what that rule looks like in
 * the type.
 */
export type PackState =
  | { status: "idle" }
  | { status: "generating" }
  | {
      status: "error";
      code: AiErrorCode;
      message: string;
      retryAfter?: number;
    }
  | {
      status: "ready";
      packing: PackingList;
      cached: boolean;
      generatedAt: string;
      /** null when no saved trip matches — ticking is disabled, not hidden. */
      trip: PackingTripState | null;
    };

export interface UsePacking {
  state: PackState;
  generate: () => void;
}

export function usePacking(request: PackingRequest): UsePacking {
  const { authFetch } = useAuth();
  const client = useMemo(() => createAiClient(authFetch), [authFetch]);
  const [state, setState] = useState<PackState>({ status: "idle" });

  const generate = useCallback(() => {
    setState({ status: "generating" });
    client
      .generatePacking(request)
      .then((res) => {
        setState({
          status: "ready",
          packing: res.packing,
          cached: res.cached,
          generatedAt: res.generatedAt,
          trip: res.trip ?? null,
        });
      })
      .catch((err: unknown) => {
        // Every failure out of the client is already an AiClientError carrying
        // the server's code; the fallback is for a genuinely unexpected throw,
        // which is the one case where "try again" really is all we can say.
        const failure =
          err instanceof AiClientError
            ? err
            : new AiClientError("provider_error", "the request could not be completed");
        setState({
          status: "error",
          code: failure.code,
          message: failure.message,
          retryAfter: failure.retryAfter,
        });
      });
    // The request object is rebuilt by the caller on every render, so it is
    // spread into primitives rather than depended on by identity — otherwise
    // `generate` changes every render and every memo below it is worthless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    request.destinationId,
    request.start,
    request.end,
    request.mode,
    request.tripId,
  ]);

  return { state, generate };
}
