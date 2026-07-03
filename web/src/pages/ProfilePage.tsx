import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth, type Trip } from "../lib/auth";
import { todayIso } from "../lib/dates";

const MODE_EMOJI = { flight: "✈️", bike: "🏍️", bus: "🚌" } as const;

function fmt(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function TripRow({
  trip,
  onStatus,
  onDelete,
}: {
  trip: Trip;
  onStatus: (id: number, status: Trip["status"]) => void;
  onDelete: (id: number) => void;
}) {
  const ended = trip.end < todayIso();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-raise p-4 ring-1 ring-white/5">
      <div>
        <p className="font-display font-semibold">
          {MODE_EMOJI[trip.mode]} {trip.destination_name}
        </p>
        <p className="mt-0.5 font-numeric text-xs text-muted">
          {fmt(trip.start)} – {fmt(trip.end)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {trip.status === "planned" && ended && (
          <>
            <span className="text-xs text-muted">Did you take it?</span>
            <button
              onClick={() => onStatus(trip.id, "taken")}
              className="rounded-full bg-jade/15 px-3 py-1 text-xs font-medium text-jade ring-1 ring-jade/40 transition hover:bg-jade/25"
            >
              ✅ Yes
            </button>
            <button
              onClick={() => onStatus(trip.id, "skipped")}
              className="rounded-full bg-rose/15 px-3 py-1 text-xs font-medium text-rose ring-1 ring-rose/40 transition hover:bg-rose/25"
            >
              ❌ No
            </button>
          </>
        )}
        {trip.status === "taken" && (
          <span className="rounded-full bg-jade/15 px-3 py-1 text-xs font-medium text-jade">
            ✅ Taken
          </span>
        )}
        {trip.status === "skipped" && (
          <span className="rounded-full bg-rose/15 px-3 py-1 text-xs font-medium text-rose">
            Skipped
          </span>
        )}
        {trip.status === "planned" && !ended && (
          <span className="rounded-full bg-sky/15 px-3 py-1 text-xs font-medium text-sky">
            🧭 Planned
          </span>
        )}
        <button
          aria-label="Remove trip"
          onClick={() => onDelete(trip.id)}
          className="grid h-7 w-7 place-items-center rounded-full text-muted transition hover:bg-rose/20 hover:text-rose"
        >
          🗑
        </button>
      </div>
    </li>
  );
}

export function ProfilePage() {
  const { user, logout, authFetch } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    authFetch<{ trips: Trip[] }>("/api/trips")
      .then(({ trips }) => setTrips(trips))
      .catch(() => setTrips([]))
      .finally(() => setLoaded(true));
  }, [authFetch]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (!user) return <Navigate to="/login" replace />;

  const setStatus = async (id: number, status: Trip["status"]) => {
    await authFetch(`/api/trips/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    load();
  };
  const remove = async (id: number) => {
    await authFetch(`/api/trips/${id}`, { method: "DELETE" });
    load();
  };

  const upcoming = trips.filter(
    (t) => t.status === "planned" && t.end >= todayIso(),
  );
  const awaiting = trips.filter(
    (t) => t.status === "planned" && t.end < todayIso(),
  );
  const past = trips.filter((t) => t.status !== "planned");

  return (
    <main className="mt-10 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-deep p-6 ring-1 ring-white/10 sm:p-8">
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-marigold font-display text-2xl font-bold text-ink">
            {user.name.charAt(0).toUpperCase()}
          </span>
          <div>
            <h2 className="font-display text-2xl font-bold">{user.name}</h2>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
        </div>
        <button
          onClick={logout}
          className="rounded-full bg-raise px-4 py-2 text-sm text-muted transition hover:text-starlight"
        >
          Sign out
        </button>
      </div>

      {awaiting.length > 0 && (
        <section className="mt-8">
          <h3 className="font-numeric text-xs font-bold uppercase tracking-widest text-marigold">
            ✦ Waiting to hear — did you go?
          </h3>
          <ul className="mt-3 space-y-3">
            {awaiting.map((t) => (
              <TripRow key={t.id} trip={t} onStatus={setStatus} onDelete={remove} />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h3 className="font-numeric text-xs font-bold uppercase tracking-widest text-sky">
          🧭 Upcoming trips
        </h3>
        {loaded && upcoming.length === 0 ? (
          <p className="mt-3 rounded-xl bg-deep/60 p-4 text-sm text-muted">
            Nothing planned yet — open the calendar, click a glowing weekend,
            and hit "Yes, I'm going" on a pick.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {upcoming.map((t) => (
              <TripRow key={t.id} trip={t} onStatus={setStatus} onDelete={remove} />
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="mt-8">
          <h3 className="font-numeric text-xs font-bold uppercase tracking-widest text-muted">
            Travel log
          </h3>
          <ul className="mt-3 space-y-3">
            {past.map((t) => (
              <TripRow key={t.id} trip={t} onStatus={setStatus} onDelete={remove} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
