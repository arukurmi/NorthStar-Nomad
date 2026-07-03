import { MONTH_NAMES, WEEKDAY_LABELS, monthMatrix, todayIso } from "../../lib/dates";

interface MonthGridProps {
  year: number;
  month: number;
}

export function MonthGrid({ year, month }: MonthGridProps) {
  const weeks = monthMatrix(year, month);
  const today = todayIso();

  return (
    <section aria-label={`${MONTH_NAMES[month - 1]} ${year}`}>
      <h2 className="font-display text-2xl font-semibold">
        {MONTH_NAMES[month - 1]}{" "}
        <span className="font-numeric text-muted">{year}</span>
      </h2>

      <div className="mt-4 grid grid-cols-7 gap-1 sm:gap-2">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="pb-2 text-center font-numeric text-xs uppercase tracking-widest text-muted"
          >
            {label}
          </div>
        ))}
        {weeks.flat().map((cell) => (
          <div
            key={cell.iso}
            className={`relative aspect-square rounded-xl p-2 sm:aspect-[4/3] ${
              cell.inMonth ? "bg-deep/70" : "bg-deep/25 text-muted/50"
            }`}
          >
            <span
              className={`font-numeric text-sm ${
                cell.iso === today
                  ? "inline-grid h-6 w-6 place-items-center rounded-full bg-marigold font-bold text-ink"
                  : ""
              }`}
            >
              {cell.dayOfMonth}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
