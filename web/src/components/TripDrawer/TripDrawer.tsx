import { useEffect, useState } from "react";
import type { SelectedRange } from "../../lib/selection";
import { formatRange } from "../../lib/selection";
import { useRecommendations } from "../../hooks/useRecommendations";
import type { Recommendations, Scope, TravelMode } from "../../lib/types";
import { ModeColumns } from "./ModeColumns";
import { DestinationDetail } from "./DestinationDetail";
import { ColumnsSkeleton } from "./CardSkeleton";
import { FilterBar } from "./FilterBar";
import type { TripFilters } from "../../lib/types";

/** 0-based calendar months covered by an ISO date range. */
function coveredMonths(start: string, end: string): number[] {
  const months = new Set<number>();
  const c = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  while (c <= e) {
    months.add(c.getUTCMonth());
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return [...months];
}

interface TripDrawerProps {
  range: SelectedRange | null;
  cityId: string;
  onClose: () => void;
}

const NO_FILTERS: TripFilters = { budget: null, vibes: [] };

type SeedKey = TravelMode | "international";

const ZERO_SEEDS: Record<SeedKey, number> = {
  flight: 0,
  bike: 0,
  bus: 0,
  international: 0,
};

function rotatePool<T>(pool: T[], seed: number): T[] {
  if (pool.length === 0) return pool;
  const shift = seed % pool.length;
  return [...pool.slice(shift), ...pool.slice(0, shift)];
}

/** Apply per-mode refresh seeds by rotating each ranked pool client-side. */
function applySeeds(
  data: Recommendations,
  seeds: Record<SeedKey, number>,
): Recommendations {
  return {
    ...data,
    india: {
      flight: rotatePool(data.india.flight, seeds.flight),
      bike: rotatePool(data.india.bike, seeds.bike),
      bus: rotatePool(data.india.bus, seeds.bus),
    },
    international: rotatePool(data.international, seeds.international),
  };
}

export function TripDrawer({ range, cityId, onClose }: TripDrawerProps) {
  const [scope, setScope] = useState<Scope>("india");
  const [seeds, setSeeds] = useState(ZERO_SEEDS);
  const [openDestination, setOpenDestination] = useState<string | null>(null);
  const [filters, setFilters] = useState<TripFilters>(NO_FILTERS);
  const { data, loading, error } = useRecommendations(
    range?.start ?? null,
    range?.end ?? null,
    cityId,
    filters,
  );

  useEffect(() => {
    setSeeds(ZERO_SEEDS);
    setOpenDestination(null);
    setFilters(NO_FILTERS);
  }, [range?.start, range?.end]);

  const refreshMode = (key: SeedKey) =>
    setSeeds((s) => ({ ...s, [key]: s[key] + 1 }));
  const shuffleAll = () => {
    // Always land back on the picks grid, even from a detail view.
    setOpenDestination(null);
    setSeeds((s) => ({
      flight: s.flight + 1,
      bike: s.bike + 1,
      bus: s.bus + 1,
      international: s.international + 1,
    }));
  };
  const switchScope = (s: Scope) => {
    setScope(s);
    // Leaving a destination detail open here hid the picks — reset it.
    setOpenDestination(null);
  };

  const rotated = data ? applySeeds(data, seeds) : null;

  return (
    <>
      {range && (
        <button
          aria-label="Close trip panel"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-ink/60 backdrop-blur-sm"
        />
      )}
      <aside
        aria-hidden={!range}
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-3xl transform overflow-y-auto bg-deep shadow-drawer transition-transform duration-300 ease-out ${
          range ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {range && (
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-numeric text-xs uppercase tracking-widest text-marigold">
                  {range.label}
                </p>
                <h3 className="mt-1 font-display text-3xl font-bold">
                  {formatRange(range)}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={shuffleAll}
                  className="rounded-full bg-raise px-3 py-1.5 text-sm text-muted transition hover:text-starlight"
                >
                  ↻ Shuffle all
                </button>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-9 w-9 place-items-center rounded-full bg-raise text-muted transition hover:text-starlight"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="mt-6 inline-flex rounded-full bg-ink p-1 font-numeric text-xs uppercase tracking-wide">
              {(["india", "international"] as Scope[]).map((s) => (
                <button
                  key={s}
                  onClick={() => switchScope(s)}
                  className={`rounded-full px-4 py-1.5 transition ${
                    scope === s
                      ? "bg-marigold font-bold text-ink"
                      : "text-muted hover:text-starlight"
                  }`}
                >
                  {s === "india" ? "India" : "International"}
                </button>
              ))}
            </div>

            {!openDestination && (
              <div className="mt-5">
                <FilterBar filters={filters} onChange={setFilters} />
              </div>
            )}

            <div className="mt-6">
              {openDestination ? (
                <div className="animate-fade-up">
                  <DestinationDetail
                    id={openDestination}
                    activeMonths={coveredMonths(range.start, range.end)}
                    onBack={() => setOpenDestination(null)}
                  />
                </div>
              ) : error ? (
                <p className="text-rose">
                  Couldn't load picks — check the server and try again.
                </p>
              ) : loading && !data ? (
                <ColumnsSkeleton />
              ) : rotated ? (
                <>
                  {rotated.shoulderSeason && (
                    <p className="mb-4 rounded-xl bg-raise p-3 text-sm text-marigold">
                      ✦ Shoulder season for these dates — these are still the
                      best picks, just not at their peak.
                    </p>
                  )}
                  <ModeColumns
                    data={rotated}
                    scope={scope}
                    onRefreshMode={refreshMode}
                    onOpenDestination={setOpenDestination}
                  />
                </>
              ) : null}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
