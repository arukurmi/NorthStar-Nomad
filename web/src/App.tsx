import { useState } from "react";
import { MonthGrid } from "./components/Calendar/MonthGrid";
import { useCalendarMonth } from "./hooks/useCalendarMonth";
import { MONTH_NAMES } from "./lib/dates";

export default function App() {
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);
  const { data, loading, error, reload } = useCalendarMonth(year, month);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            <span aria-hidden className="mr-2 text-marigold">
              ✦
            </span>
            Northstar Nomad
          </h1>
          <p className="mt-1 text-sm text-muted">
            Your free weekends, already planned.
          </p>
        </div>
        <p className="hidden font-numeric text-xs uppercase tracking-widest text-muted sm:block">
          from Delhi-NCR
        </p>
      </header>

      <main className="mt-8">
        <h2 className="mb-4 font-display text-2xl font-semibold">
          {MONTH_NAMES[month - 1]}{" "}
          <span className="font-numeric text-muted">{year}</span>
        </h2>

        {error ? (
          <div className="grid min-h-[40vh] place-items-center rounded-card bg-deep/60">
            <div className="text-center">
              <p className="text-muted">The night sky is unreachable — is the server running?</p>
              <button
                onClick={reload}
                className="mt-3 rounded-full bg-marigold px-4 py-1.5 font-semibold text-ink"
              >
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className={loading && !data ? "animate-pulse opacity-50" : ""}>
            <MonthGrid year={year} month={month} calendar={data} />
          </div>
        )}
      </main>
    </div>
  );
}
