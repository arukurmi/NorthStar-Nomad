import { useCallback, useEffect, useState } from "react";
import { MonthGrid } from "../components/Calendar/MonthGrid";
import { MonthNav } from "../components/Calendar/MonthNav";
import { TripDrawer } from "../components/TripDrawer/TripDrawer";
import { CheckInPrompt } from "../components/CheckInPrompt";
import { useCalendarMonth } from "../hooks/useCalendarMonth";
import { addDays, dayOfWeek, todayIso } from "../lib/dates";
import { rangeForDay, type SelectedRange } from "../lib/selection";
import type { City } from "../lib/types";

/** ISO date of the upcoming Saturday (today if it is one). */
export function nextSaturday(fromIso: string): string {
  const dow = dayOfWeek(fromIso); // 0 Sun … 6 Sat
  const delta = dow === 6 ? 0 : (6 - dow + 7) % 7;
  return addDays(fromIso, delta);
}

interface CalendarPageProps {
  city: City | null;
}

export function CalendarPage({ city }: CalendarPageProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [highlightIso, setHighlightIso] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedRange | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [hoverIso, setHoverIso] = useState<string | null>(null);
  const [slideDir, setSlideDir] = useState<"left" | "right">("right");
  const { data, loading, error, reload } = useCalendarMonth(
    year,
    month,
    city?.id ?? "delhi-ncr",
  );

  const changeMonth = useCallback(
    (y: number, m: number) => {
      setSlideDir(y * 12 + m > year * 12 + month ? "right" : "left");
      setYear(y);
      setMonth(m);
    },
    [year, month],
  );

  const jumpToNextWeekend = useCallback(() => {
    const sat = nextSaturday(todayIso());
    setSlideDir("right");
    setYear(Number(sat.slice(0, 4)));
    setMonth(Number(sat.slice(5, 7)));
    setHighlightIso(sat);
  }, []);

  const tripDayCount = (start: string, end: string) =>
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    ) + 1;

  const openRange = useCallback((start: string, end: string) => {
    const days = tripDayCount(start, end);
    setSelected({ start, end, label: `${days}-day trip` });
    setRangeMode(false);
    setDraftStart(null);
  }, []);

  const handleSelectDay = (iso: string) => {
    if (!rangeMode) {
      setSelected(rangeForDay(iso, data));
      return;
    }
    if (!draftStart) {
      setDraftStart(iso);
      return;
    }
    const [start, end] =
      draftStart <= iso ? [draftStart, iso] : [iso, draftStart];
    openRange(start, end);
  };

  const presetRange = (days: number) => {
    const start = todayIso();
    openRange(start, addDays(start, days - 1));
  };

  const rangePaint = selected
    ? { start: selected.start, end: selected.end }
    : rangeMode && draftStart
      ? draftStart <= (hoverIso ?? draftStart)
        ? { start: draftStart, end: hoverIso ?? draftStart }
        : { start: hoverIso ?? draftStart, end: draftStart }
      : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setRangeMode(false);
        setDraftStart(null);
      } else if (e.key === "ArrowLeft") {
        changeMonth(
          month === 1 ? year - 1 : year,
          month === 1 ? 12 : month - 1,
        );
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
    <main className="mt-8">
      <MonthNav
        year={year}
        month={month}
        onChange={changeMonth}
        onJumpToNextWeekend={jumpToNextWeekend}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setRangeMode((m) => !m);
            setDraftStart(null);
            setSelected(null);
          }}
          className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition ${
            rangeMode
              ? "bg-sky text-ink ring-sky"
              : "bg-sky/10 text-sky ring-sky/40 hover:bg-sky/20"
          }`}
        >
          🎯 Pick a date range
        </button>
        <button
          onClick={() => presetRange(10)}
          className="rounded-full bg-jade/10 px-3 py-1.5 text-sm font-medium text-jade ring-1 ring-jade/40 transition hover:bg-jade/20"
        >
          ⚡ Next 10 days
        </button>
        <button
          onClick={() => presetRange(14)}
          className="rounded-full bg-jade/10 px-3 py-1.5 text-sm font-medium text-jade ring-1 ring-jade/40 transition hover:bg-jade/20"
        >
          🗓️ Next 2 weeks
        </button>
        {rangeMode && (
          <span className="animate-fade-up text-sm text-sky">
            {draftStart ? "Now click your last day →" : "Click your first day…"}
          </span>
        )}
      </div>

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
        <div
          key={`${year}-${month}`}
          className={`${
            slideDir === "right"
              ? "animate-slide-from-right"
              : "animate-slide-from-left"
          } ${loading && !data ? "animate-pulse opacity-50" : ""}`}
        >
          <MonthGrid
            year={year}
            month={month}
            calendar={data}
            highlightIso={highlightIso}
            rangePaint={rangePaint}
            rangeMode={rangeMode}
            onSelectDay={handleSelectDay}
            onHoverDay={setHoverIso}
          />
        </div>
      )}

      <TripDrawer
        range={selected}
        cityId={city?.id ?? "delhi-ncr"}
        onClose={() => setSelected(null)}
      />

      <CheckInPrompt />
    </main>
  );
}
