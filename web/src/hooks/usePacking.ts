import { useCallback, useMemo, useRef, useState } from "react";
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
  /** Flips one item. No-op unless the state is `ready` with a saved trip. */
  toggle: (itemKey: string, checked: boolean) => void;
  /** Item keys with a tick in flight, so a row can disable itself. */
  pending: ReadonlySet<string>;
  /** Set when a tick failed and was rolled back. Cleared by the next attempt. */
  tickError: string | null;
}

export function usePacking(request: PackingRequest): UsePacking {
  const { authFetch } = useAuth();
  const client = useMemo(() => createAiClient(authFetch), [authFetch]);
  const [state, setState] = useState<PackState>({ status: "idle" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [tickError, setTickError] = useState<string | null>(null);
  // A ref, not state: this must be readable synchronously inside `toggle` to
  // reject a second click that arrives before React has re-rendered. Reading
  // `pending` there would see the value from the render that scheduled it.
  const inFlight = useRef<Set<string>>(new Set());

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

  /**
   * Optimistic, with an exact revert.
   *
   * The tick is applied locally first because a checkbox that waits for a round
   * trip feels broken, and packing is a rapid-fire interaction — someone
   * standing over a bag ticks eight things in ten seconds. On success the
   * server's counts replace the optimistic ones: they are recomputed from the
   * rows, so two open tabs converge instead of drifting apart. On failure only
   * that one item is reverted, and the error names the item rather than
   * blanking the list.
   */
  const toggle = useCallback(
    (itemKey: string, checked: boolean) => {
      if (state.status !== "ready" || !state.trip) return;
      // Double-click guard. Without it the second click sends the same value
      // again and the two responses race to set the counts.
      if (inFlight.current.has(itemKey)) return;
      inFlight.current.add(itemKey);
      setPending(new Set(inFlight.current));
      setTickError(null);

      const tripId = state.trip.id;
      const previous = state.trip.checked[itemKey] ?? false;

      const applyLocal = (next: boolean, counts?: { checkedCount: number; total: number }) =>
        setState((current) => {
          if (current.status !== "ready" || !current.trip) return current;
          const merged = { ...current.trip.checked, [itemKey]: next };
          return {
            ...current,
            trip: {
              ...current.trip,
              checked: merged,
              checkedCount:
                counts?.checkedCount ??
                Object.values(merged).filter(Boolean).length,
              total: counts?.total ?? current.trip.total,
            },
          };
        });

      applyLocal(checked);

      const settle = () => {
        inFlight.current.delete(itemKey);
        setPending(new Set(inFlight.current));
      };

      client
        .setPackingItem(tripId, itemKey, checked)
        .then((res) => {
          applyLocal(res.checked, {
            checkedCount: res.checkedCount,
            total: res.total,
          });
          settle();
        })
        .catch((err: unknown) => {
          applyLocal(previous);
          setTickError(
            err instanceof AiClientError
              ? err.message
              : "that tick did not save — try again",
          );
          settle();
        });
    },
    [client, state],
  );

  return { state, generate, toggle, pending, tickError };
}
