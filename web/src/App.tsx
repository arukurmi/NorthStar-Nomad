import { useCallback, useEffect, useState } from "react";
import { MonthGrid } from "./components/Calendar/MonthGrid";
import { MonthNav } from "./components/Calendar/MonthNav";
import { TripDrawer } from "./components/TripDrawer/TripDrawer";
import { useCalendarMonth } from "./hooks/useCalendarMonth";
import { addDays, dayOfWeek, todayIso } from "./lib/dates";
import { rangeForDay, type SelectedRange } from "./lib/selection";

/** ISO date of the upcoming Saturday (today if it is one). */
export function nextSaturday(fromIso: string): string {
  const dow = dayOfWeek(fromIso); // 0 Sun … 6 Sat
  const delta = dow === 6 ? 0 : (6 - dow + 7) % 7;
  return addDays(fromIso, delta);
}

export default function App() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [highlightIso, setHighlightIso] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedRange | null>(null);
  const { data, loading, error, reload } = useCalendarMonth(year, month);

  const changeMonth = useCallback((y: number, m: number) => {
    setYear(y);
    setMonth(m);
  }, []);

  const jumpToNextWeekend = useCallback(() => {
    const sat = nextSaturday(todayIso());
    setYear(Number(sat.slice(0, 4)));
    setMonth(Number(sat.slice(5, 7)));
    setHighlightIso(sat);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
      } else if (e.key === "ArrowLeft") {
        changeMonth(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
      } else if (e.key === "ArrowRight") {
        changeMonth(
          month === 12 ? year + 1 : year,
          month === 12 ? 1 : month + 1,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [year, month, changeMonth]);

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
        <MonthNav
          year={year}
          month={month}
          onChange={changeMonth}
          onJumpToNextWeekend={jumpToNextWeekend}
        />

        {error ? (
          <div className="grid min-h-[40vh] place-items-center rounded-card bg-deep/60">
            <div className="text-center">
              <p className="text-muted">
                The night sky is unreachable — is the server running?
              </p>
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
            <MonthGrid
              year={year}
              month={month}
              calendar={data}
              highlightIso={highlightIso}
              onSelectDay={(iso) => setSelected(rangeForDay(iso, data))}
            />
          </div>
        )}
      </main>

      <TripDrawer range={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
