import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDestination } from "../../lib/api";
import type { Destination, TravelMode } from "../../lib/types";
import { useAuth } from "../../lib/auth";

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
  range: { start: string; end: string };
  mode: TravelMode;
  onBack: () => void;
}

export function DestinationDetail({
  id,
  activeMonths,
  range,
  mode,
  onBack,
}: DestinationDetailProps) {
  const { user, authFetch } = useAuth();
  const [dest, setDest] = useState<Destination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planState, setPlanState] = useState<
    "idle" | "saving" | "saved" | "declined" | "duplicate"
  >("idle");

  const planTrip = async () => {
    setPlanState("saving");
    try {
      await authFetch("/api/trips", {
        method: "POST",
        body: JSON.stringify({
          destinationId: id,
          start: range.start,
          end: range.end,
          mode,
        }),
      });
      setPlanState("saved");
    } catch (e) {
      setPlanState(
        (e as Error).message.includes("already") ? "duplicate" : "idle",
      );
    }
  };

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

      <div className="mt-8 rounded-card bg-raise p-5 ring-1 ring-marigold/30">
        {!user ? (
          <p className="text-sm text-muted">
            <Link to="/login" className="font-semibold text-marigold underline">
              Sign in
            </Link>{" "}
            to save this trip to your plans and get a check-in after it.
          </p>
        ) : planState === "saved" ? (
          <p className="animate-fade-up text-sm font-medium text-jade">
            🧭 Added to your trips! We'll ask how it went once you're back.{" "}
            <Link to="/profile" className="underline">
              View your plans →
            </Link>
          </p>
        ) : planState === "duplicate" ? (
          <p className="text-sm text-sky">
            This trip is already in your plans.{" "}
            <Link to="/profile" className="underline">
              See it →
            </Link>
          </p>
        ) : planState === "declined" ? (
          <p className="text-sm text-muted">
            No worries — hit ↻ on the picks for another idea.
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-display font-semibold">
              Planning to take this trip?
            </p>
            <div className="flex gap-2">
              <button
                onClick={planTrip}
                disabled={planState === "saving"}
                className="rounded-full bg-marigold px-4 py-1.5 text-sm font-bold text-ink transition hover:brightness-110 disabled:opacity-60"
              >
                {planState === "saving" ? "Saving…" : "✅ Yes, I'm going"}
              </button>
              <button
                onClick={() => setPlanState("declined")}
                className="rounded-full bg-deep px-4 py-1.5 text-sm text-muted transition hover:text-starlight"
              >
                Not this one
              </button>
            </div>
          </div>
        )}
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
