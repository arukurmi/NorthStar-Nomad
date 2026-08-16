import { useCallback, useMemo, useState } from "react";
import { createAiClient } from "../../lib/ai";
import { useAuth } from "../../lib/auth";
import type { StoredPackingCategory, TravelMode } from "../../lib/types";

interface TripPackingCardProps {
  tripId: number;
  mode: TravelMode;
  total: number;
  checked: number;
}

type CardState =
  | { status: "collapsed" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "open";
      categories: StoredPackingCategory[];
      checkedCount: number;
      total: number;
    };

/**
 * A trip row's packing progress, expanding to the stored checklist.
 *
 * Everything here reads `trip_packing` and nothing else — no AI key, no
 * provider call, no cache lookup. That is the whole justification for storing
 * the checklist rather than a set of booleans: a user who removed their key,
 * or whose cached row expired weeks ago, can still open this and tick things
 * off on the morning they pack.
 *
 * Collapsed by default and fetched only on expand. The counts come free with
 * `GET /api/trips`, so the list of trips costs one request no matter how many
 * trips it holds; the checklist itself is the only per-trip fetch, and it
 * happens when somebody actually asks for it.
 */
export function TripPackingCard({
  tripId,
  mode,
  total,
  checked,
}: TripPackingCardProps) {
  const { authFetch } = useAuth();
  const client = useMemo(() => createAiClient(authFetch), [authFetch]);
  const [state, setState] = useState<CardState>({ status: "collapsed" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const open = useCallback(() => {
    setState({ status: "loading" });
    client
      .readTripPacking(tripId)
      .then((res) =>
        setState({
          status: "open",
          categories: res.categories,
          checkedCount: res.checkedCount,
          total: res.total,
        }),
      )
      .catch(() =>
        setState({
          status: "error",
          message: "Couldn't load this checklist just now.",
        }),
      );
  }, [client, tripId]);

  const toggle = useCallback(
    (itemKey: string, next: boolean) => {
      if (pending.has(itemKey)) return;
      setPending(new Set([...pending, itemKey]));
      client
        .setPackingItem(tripId, itemKey, next)
        .then((res) =>
          setState((current) =>
            current.status === "open"
              ? {
                  ...current,
                  checkedCount: res.checkedCount,
                  total: res.total,
                  categories: current.categories.map((category) => ({
                    ...category,
                    items: category.items.map((item) =>
                      item.itemKey === itemKey
                        ? { ...item, checked: res.checked }
                        : item,
                    ),
                  })),
                }
              : current,
          ),
        )
        .finally(() =>
          setPending((current) => {
            const next2 = new Set(current);
            next2.delete(itemKey);
            return next2;
          }),
        );
    },
    [client, tripId, pending],
  );

  // Nothing generated yet: no card at all, rather than an empty one. A trip
  // with no list has nothing to say here, and a 0/0 bar is noise on a page
  // that is mostly other trips.
  if (total === 0 && state.status === "collapsed") return null;

  const shownChecked =
    state.status === "open" ? state.checkedCount : checked;
  const shownTotal = state.status === "open" ? state.total : total;
  const pct = shownTotal === 0 ? 0 : Math.round((shownChecked / shownTotal) * 100);

  return (
    <div className="mt-3 w-full rounded-xl bg-deep/60 p-3 ring-1 ring-white/5">
      <button
        type="button"
        onClick={() =>
          state.status === "collapsed" || state.status === "error"
            ? open()
            : setState({ status: "collapsed" })
        }
        className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <span className="shrink-0 font-numeric text-xs uppercase tracking-widest text-marigold">
            🎒 Packing
          </span>
          <span className="h-1.5 min-w-[3rem] flex-1 overflow-hidden rounded-full bg-raise">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-marigold to-jade transition-all duration-500"
              style={{ width: `${pct}%`, opacity: pct === 0 ? 0 : 1 }}
            />
          </span>
        </span>
        <span className="shrink-0 font-numeric text-xs text-muted">
          {shownChecked}/{shownTotal}
        </span>
      </button>

      {state.status === "loading" && (
        <p className="mt-2 text-xs text-muted">Loading your checklist…</p>
      )}
      {state.status === "error" && (
        <p className="mt-2 text-xs text-rose">{state.message}</p>
      )}
      {state.status === "open" && (
        <div className="animate-fade-up mt-3 space-y-3">
          {state.categories.map((category) => (
            <div key={category.name}>
              <p
                className={`font-numeric text-[11px] uppercase tracking-widest ${
                  category.modeCategory ? "text-marigold" : "text-muted"
                }`}
              >
                {category.name}
              </p>
              <ul className="mt-1">
                {category.items.map((item) => (
                  <li key={item.itemKey}>
                    <label className="flex min-h-[40px] cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 transition hover:bg-raise/50">
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={(e) => toggle(item.itemKey, e.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-marigold"
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`text-sm leading-snug ${
                            item.checked
                              ? "text-muted line-through"
                              : "text-starlight"
                          }`}
                        >
                          {item.label}
                          {item.qty > 1 && (
                            <span className="ml-1.5 font-numeric text-xs text-marigold">
                              {item.qty} ×
                            </span>
                          )}
                        </span>
                        {item.reason && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                            {item.reason}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="font-numeric text-[11px] text-muted">
            Saved with this trip — no AI key needed to tick things off. ✦ {mode}
          </p>
        </div>
      )}
    </div>
  );
}
