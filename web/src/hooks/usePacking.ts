import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** True while the free rehydrate from stored state is running. */
  restoring: boolean;
  /** Flips one item. No-op unless the state is `ready` with a saved trip. */
  toggle: (itemKey: string, checked: boolean) => void;
  /** Item keys with a tick in flight, so a row can disable itself. */
  pending: ReadonlySet<string>;
  /** Set when a tick failed and was rolled back. Cleared by the next attempt. */
  tickError: string | null;
}

export function usePacking(request: PackingRequest): UsePacking {
  // Destructured so the dependency list can name primitives. Depending on
  // `request` itself would make `generate` a new function every render, since
  // the caller rebuilds the object; suppressing the lint rule instead is what
  // let `provider` go missing from the list unnoticed.
  const { destinationId, start, end, mode, tripId, provider } = request;
  const { authFetch } = useAuth();
  const client = useMemo(() => createAiClient(authFetch), [authFetch]);
  const [state, setState] = useState<PackState>({ status: "idle" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [tickError, setTickError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // A ref, not state: this must be readable synchronously inside `toggle` to
  // reject a second click that arrives before React has re-rendered. Reading
  // `pending` there would see the value from the render that scheduled it.
  const inFlight = useRef<Set<string>>(new Set());

  const generate = useCallback(() => {
    setState({ status: "generating" });
    // A stale "that tick did not save" would otherwise survive onto the fresh
    // list, where it refers to an item that may no longer be on it.
    setTickError(null);
    client
      .generatePacking({ destinationId, start, end, mode, tripId, provider })
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
  }, [client, destinationId, start, end, mode, tripId, provider]);

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
          // The trip-id guard matters: a `generate` can resolve while a tick is
          // in flight, and without it a late response would write into a
          // different trip's state.
          if (current.status !== "ready" || !current.trip) return current;
          if (current.trip.id !== tripId) return current;
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
          // Each response carries an authoritative snapshot, but responses can
          // land out of order — ticking A then B and having B answer first
          // would leave A's older count on screen while both items show as
          // ticked, and it would stick until the next tick. So the server's
          // count is only adopted when this was the last outstanding tick.
          // Until then the locally recomputed count is correct by construction,
          // because the map is dense over every item.
          inFlight.current.delete(itemKey);
          const settled = inFlight.current.size === 0;
          applyLocal(
            res.checked,
            settled
              ? { checkedCount: res.checkedCount, total: res.total }
              : undefined,
          );
          setPending(new Set(inFlight.current));
        })
        .catch((err: unknown) => {
          const gone =
            err instanceof AiClientError && err.code === "not_found";
          if (gone) {
            // The trip was deleted in another tab. Keep inviting ticks and
            // every one of them fails the same way; dropping to the untickable
            // state renders the "save this trip" note instead.
            setState((current) =>
              current.status === "ready" ? { ...current, trip: null } : current,
            );
          } else {
            applyLocal(previous);
          }
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

  /**
   * Free rehydrate. `GET /api/trips/:id/packing` reads the stored snapshot: no
   * AI key, no provider call, no cache lookup, and no charge — so a reload
   * shows the user the list they already have instead of an idle panel that
   * invites them to buy it again.
   *
   * It only runs when the caller knows a trip id, which is exactly when a
   * snapshot can exist. Silence on failure is deliberate: this is an
   * opportunistic restore, and the idle state it falls back to is a correct,
   * usable screen rather than an error.
   */
  useEffect(() => {
    if (tripId === undefined) return;
    let cancelled = false;
    setRestoring(true);
    client
      .readTripPacking(tripId)
      .then((res) => {
        if (cancelled || res.total === 0) return;
        setState({
          status: "ready",
          packing: {
            summary: "Saved with this trip.",
            categories: res.categories.map((category) => ({
              name: category.name,
              modeCategory: category.modeCategory,
              items: category.items.map(({ checked: _checked, ...item }) => item),
            })),
          },
          cached: true,
          generatedAt: new Date().toISOString(),
          trip: {
            id: tripId,
            checked: Object.fromEntries(
              res.categories.flatMap((category) =>
                category.items.map((item) => [item.itemKey, item.checked]),
              ),
            ),
            checkedCount: res.checkedCount,
            total: res.total,
          },
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, tripId]);

  return { state, generate, toggle, pending, tickError, restoring };
}
