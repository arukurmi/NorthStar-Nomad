import type { Pick } from "../../lib/types";

interface DestinationCardProps {
  pick: Pick;
  onOpen?: (id: string) => void;
}

export function DestinationCard({ pick, onOpen }: DestinationCardProps) {
  const d = pick.destination;
  return (
    <button
      onClick={() => onOpen?.(d.id)}
      className="group w-full overflow-hidden rounded-card bg-raise text-left ring-1 ring-white/5 transition hover:-translate-y-0.5 hover:ring-sky/40"
    >
      <div
        aria-hidden
        className="relative h-24 w-full"
        style={{ background: d.heroGradient }}
      >
        <span className="absolute bottom-2 right-3 rounded-full bg-ink/50 px-2 py-0.5 font-numeric text-xs text-starlight backdrop-blur">
          {d.budgetTier}
        </span>
      </div>
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="font-display text-lg font-semibold leading-tight">
            {d.name}
          </h4>
          <span className="shrink-0 font-numeric text-xs text-muted">
            {d.scope === "india"
              ? `${d.distanceKm.toLocaleString("en-IN")} km`
              : d.country}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">{d.region}</p>

        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-deep px-2.5 py-1 text-xs text-sky">
          <span aria-hidden>☁</span>
          {pick.weatherNow.tempMin}–{pick.weatherNow.tempMax}°C ·{" "}
          {pick.weatherNow.summary}
        </p>

        <p className="mt-2 line-clamp-2 text-sm text-starlight/80">
          {pick.whyNow}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-full bg-deep px-2 py-0.5 font-numeric text-[10px] uppercase tracking-wide text-muted"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}
