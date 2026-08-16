/**
 * Shimmer rows while a list generates.
 *
 * Shaped like the real thing — a progress bar, then category blocks with rows
 * of two different widths — because a skeleton that does not match its content
 * causes a visible jump when the content lands, which is worse than a spinner.
 *
 * A generation is a real network call to a vendor and can take ten seconds or
 * more, so this is on screen long enough to be looked at rather than glimpsed.
 */
export function PackingSkeleton() {
  return (
    <div aria-busy className="animate-fade-up space-y-3" role="status">
      <span className="sr-only">Building your packing list…</span>
      <div className="h-2 w-full rounded-full bg-raise" />
      {[0, 1, 2].map((section) => (
        <div
          key={section}
          className="rounded-card bg-deep/50 p-4 ring-1 ring-white/5"
        >
          <div className="h-4 w-32 rounded bg-raise" />
          <div className="mt-3 space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <div className="h-5 w-5 shrink-0 rounded bg-raise" />
                <div
                  className="h-3.5 rounded bg-raise"
                  // Uneven widths, seeded from the indices rather than random:
                  // a re-render must not reshuffle the bars, which reads as
                  // flicker rather than as loading.
                  style={{ width: `${52 + ((section * 3 + row) % 4) * 11}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
