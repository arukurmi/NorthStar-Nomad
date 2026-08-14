import type { AiFeature, UsageResponse } from "../../lib/types";

const FEATURE_LABEL: Record<AiFeature, string> = {
  itinerary: "Day-by-day plans",
  packing: "Packing lists",
  budget: "Budget estimates",
  search: "Plain-language search",
};

/** 8200 → "8.2k". Token counts are scale, not accountancy. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * What the user has spent, and — the part worth showing — what they didn't.
 * Cached calls are answers we already had, so they cost the user nothing; they
 * get their own column rather than being quietly folded into the total.
 */
export function UsageSummary({ usage, totals }: UsageResponse) {
  // Nothing to report is not an empty table, it is no table.
  if (usage.length === 0) return null;

  const savedPct =
    totals.calls > 0 ? Math.round((totals.cachedCalls / totals.calls) * 100) : 0;

  return (
    <div className="mt-4 rounded-xl bg-deep/60 p-4 ring-1 ring-white/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-numeric text-[11px] font-bold uppercase tracking-widest text-muted">
          What you've used
        </h4>
        {totals.cachedCalls > 0 && (
          <p className="font-numeric text-[11px] text-jade">
            {savedPct}% served from cache — free
          </p>
        )}
      </div>

      <ul className="mt-3 space-y-2">
        {usage.map((row) => (
          <li
            key={row.feature}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-white/5 pt-2 first:border-0 first:pt-0"
          >
            <span className="text-sm">
              {FEATURE_LABEL[row.feature] ?? row.feature}
            </span>
            <span className="font-numeric text-xs text-muted">
              {row.calls} {row.calls === 1 ? "call" : "calls"}
              {row.cachedCalls > 0 && (
                <span className="text-jade"> · {row.cachedCalls} cached</span>
              )}{" "}
              · {compact(row.inputTokens)} in · {compact(row.outputTokens)} out
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-white/5 pt-2 font-numeric text-xs text-muted">
        <span className="text-starlight">Total</span> · {totals.calls}{" "}
        {totals.calls === 1 ? "call" : "calls"}
        {totals.cachedCalls > 0 && (
          <span className="text-jade"> · {totals.cachedCalls} cached</span>
        )}{" "}
        · {compact(totals.inputTokens)} in · {compact(totals.outputTokens)} out
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Billed by your provider, not by us. Cached answers were already
        computed for someone else's identical question, so they cost nothing and
        never contain anything about you.
      </p>
    </div>
  );
}
