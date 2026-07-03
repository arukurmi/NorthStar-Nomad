import { useEffect, useState } from "react";
import { fetchDestination } from "../../lib/api";
import type { Destination } from "../../lib/types";

const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function scoreColor(score: number): string {
  if (score >= 8) return "bg-jade";
  if (score >= 6) return "bg-sky";
  if (score >= 4) return "bg-marigold/70";
  return "bg-rose/60";
}

interface DestinationDetailProps {
  id: string;
  /** 0-based months covered by the selected trip, for highlighting. */
  activeMonths: number[];
  onBack: () => void;
}

export function DestinationDetail({
  id,
  activeMonths,
  onBack,
}: DestinationDetailProps) {
  const [dest, setDest] = useState<Destination | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDest(null);
    setError(null);
    fetchDestination(id)
      .then((d) => {
        if (!cancelled) setDest(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return <p className="text-rose">Couldn't load this destination.</p>;
  }
  if (!dest) {
    return <p className="text-muted">Loading destination…</p>;
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 rounded-full bg-raise px-3 py-1.5 text-sm text-muted transition hover:text-starlight"
      >
        ← Back to picks
      </button>

      <div
        aria-hidden
        className="h-36 w-full rounded-card"
        style={{ background: dest.heroGradient }}
      />

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-3xl font-bold">{dest.name}</h3>
        <p className="font-numeric text-sm text-muted">
          {dest.region} · {dest.country} · {dest.budgetTier}
        </p>
      </div>

      <p className="mt-3 text-starlight/85">{dest.blurb}</p>
      <p className="mt-2 text-sm text-muted">
        Best for: {dest.bestFor} · Ideal trip: {dest.idealDays}+ day
        {dest.idealDays > 1 ? "s" : ""}
      </p>

      <h4 className="mt-8 font-numeric text-xs font-bold uppercase tracking-widest text-muted">
        When to go
      </h4>
      <div className="mt-3 grid grid-cols-12 items-end gap-1.5">
        {dest.monthScores.map((score, i) => (
          <div key={i} className="text-center">
            <div
              className={`mx-auto w-full rounded-t ${scoreColor(score)} ${
                activeMonths.includes(i)
                  ? "ring-2 ring-marigold shadow-star-soft"
                  : "opacity-80"
              }`}
              style={{ height: `${8 + score * 6}px` }}
              title={`${dest.weather[i].summary} (${dest.weather[i].tempMin}–${dest.weather[i].tempMax}°C)`}
            />
            <span
              className={`mt-1 block font-numeric text-[10px] ${
                activeMonths.includes(i)
                  ? "font-bold text-marigold"
                  : "text-muted"
              }`}
            >
              {MONTH_INITIALS[i]}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {activeMonths.map((m) => (
          <p key={m} className="rounded-xl bg-raise p-3 text-sm text-sky">
            ☁ Your dates: {dest.weather[m].tempMin}–{dest.weather[m].tempMax}
            °C — {dest.weather[m].summary}
          </p>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-1.5">
        {dest.tags.map((t) => (
          <span
            key={t}
            className="rounded-full bg-raise px-2.5 py-1 font-numeric text-xs uppercase tracking-wide text-muted"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
