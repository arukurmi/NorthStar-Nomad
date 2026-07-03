import { useEffect, useState } from "react";
import { useAuth, type Trip } from "../lib/auth";

const MODE_EMOJI = { flight: "✈️", bike: "🏍️", bus: "🚌" } as const;

function fmt(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Asks "did you take this trip?" for planned trips whose dates have passed. */
export function CheckInPrompt() {
  const { user, authFetch } = useAuth();
  const [queue, setQueue] = useState<Trip[]>([]);

  useEffect(() => {
    if (!user) {
      setQueue([]);
      return;
    }
    authFetch<{ trips: Trip[] }>("/api/trips/check-in")
      .then(({ trips }) => setQueue(trips))
      .catch(() => setQueue([]));
  }, [user, authFetch]);

  const current = queue[0];
  if (!user || !current) return null;

  const answer = async (status: "taken" | "skipped") => {
    await authFetch(`/api/trips/${current.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="fixed inset-x-4 bottom-4 z-30 mx-auto max-w-lg animate-fade-up rounded-card bg-deep p-5 shadow-drawer ring-1 ring-marigold/40">
      <p className="font-numeric text-xs uppercase tracking-widest text-marigold">
        ✦ Welcome back
      </p>
      <p className="mt-2 font-display text-lg font-semibold">
        Did you take this trip? {MODE_EMOJI[current.mode]}{" "}
        {current.destination_name}
      </p>
      <p className="mt-0.5 font-numeric text-xs text-muted">
        {fmt(current.start)} – {fmt(current.end)}
      </p>
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => answer("taken")}
          className="rounded-full bg-jade px-4 py-1.5 text-sm font-bold text-ink transition hover:brightness-110"
        >
          ✅ Yes, went!
        </button>
        <button
          onClick={() => answer("skipped")}
          className="rounded-full bg-raise px-4 py-1.5 text-sm text-muted transition hover:text-starlight"
        >
          ❌ Didn't happen
        </button>
      </div>
    </div>
  );
}
