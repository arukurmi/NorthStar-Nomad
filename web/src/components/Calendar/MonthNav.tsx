import { MONTH_NAMES } from "../../lib/dates";

interface MonthNavProps {
  year: number;
  month: number;
  onChange: (year: number, month: number) => void;
  onJumpToNextWeekend: () => void;
}

export function MonthNav({
  year,
  month,
  onChange,
  onJumpToNextWeekend,
}: MonthNavProps) {
  const prev = () =>
    month === 1 ? onChange(year - 1, 12) : onChange(year, month - 1);
  const next = () =>
    month === 12 ? onChange(year + 1, 1) : onChange(year, month + 1);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display text-2xl font-semibold">
        {MONTH_NAMES[month - 1]}{" "}
        <span className="font-numeric text-muted">{year}</span>
      </h2>
      <div className="flex items-center gap-2">
        <button
          onClick={onJumpToNextWeekend}
          className="rounded-full bg-marigold/15 px-3 py-1.5 text-sm font-medium text-marigold ring-1 ring-marigold/40 transition hover:bg-marigold/25"
        >
          Next free weekend →
        </button>
        <button
          aria-label="Previous month"
          onClick={prev}
          className="grid h-9 w-9 place-items-center rounded-full bg-deep ring-1 ring-raise transition hover:bg-raise"
        >
          ‹
        </button>
        <button
          aria-label="Next month"
          onClick={next}
          className="grid h-9 w-9 place-items-center rounded-full bg-deep ring-1 ring-raise transition hover:bg-raise"
        >
          ›
        </button>
      </div>
    </div>
  );
}
