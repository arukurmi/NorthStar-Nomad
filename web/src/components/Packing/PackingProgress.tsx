interface PackingProgressProps {
  checked: number;
  total: number;
  /** False when no saved trip matches: the bar is context, not progress. */
  tickable: boolean;
}

/**
 * "11 / 24 packed", with a gradient bar.
 *
 * The gradient is inline and CSS-only, exactly like `Destination.heroGradient`
 * — this app ships no image assets, and a progress bar is not the place to
 * start. It runs marigold to jade so "done" reads as arrival rather than as
 * more of the same colour.
 */
export function PackingProgress({
  checked,
  total,
  tickable,
}: PackingProgressProps) {
  const pct = total === 0 ? 0 : Math.round((checked / total) * 100);
  const complete = total > 0 && checked === total;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-numeric text-sm">
          <span
            className={complete ? "font-bold text-jade" : "font-bold text-marigold"}
          >
            {checked}
          </span>
          <span className="text-muted"> / {total} packed</span>
        </p>
        {complete && (
          <p className="animate-fade-up font-numeric text-xs uppercase tracking-widest text-jade">
            ✦ All packed
          </p>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={checked}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Items packed"
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-raise"
      >
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, #FFB648 0%, #38D1A5 100%)",
            // A zero-width bar with a border radius still paints a dot on some
            // engines, which reads as "one thing done" when nothing is.
            opacity: pct === 0 ? 0 : 1,
          }}
        />
      </div>
      {!tickable && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Save this trip to your plans to tick items off.
        </p>
      )}
    </div>
  );
}
