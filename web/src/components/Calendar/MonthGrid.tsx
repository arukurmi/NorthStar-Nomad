import type { CalendarMonth, LongWeekend } from "../../lib/types";
import {
  MONTH_NAMES,
  WEEKDAY_LABELS,
  monthMatrix,
  todayIso,
} from "../../lib/dates";

interface MonthGridProps {
  year: number;
  month: number;
  calendar: CalendarMonth | null;
}

function longWeekendFor(
  iso: string,
  longWeekends: LongWeekend[],
): LongWeekend | undefined {
  return longWeekends.find((lw) => iso >= lw.start && iso <= lw.end);
}

export function MonthGrid({ year, month, calendar }: MonthGridProps) {
  const weeks = monthMatrix(year, month);
  const today = todayIso();
  const dayInfo = new Map(calendar?.days.map((d) => [d.date, d]) ?? []);
  const longWeekends = calendar?.longWeekends ?? [];
  const teasers = calendar?.teasers ?? {};

  return (
    <section aria-label={`${MONTH_NAMES[month - 1]} ${year}`}>
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="pb-2 text-center font-numeric text-xs uppercase tracking-widest text-muted"
          >
            {label}
          </div>
        ))}
        {weeks.flat().map((cell) => {
          const info = dayInfo.get(cell.iso);
          const lw = cell.inMonth
            ? longWeekendFor(cell.iso, longWeekends)
            : undefined;
          const isWeekendGlow = cell.inMonth && (info?.isWeekend || lw);
          const teaser = cell.inMonth ? teasers[cell.iso] : undefined;

          const base = cell.inMonth
            ? lw
              ? "bg-raise ring-1 ring-marigold/50 shadow-star-soft"
              : info?.isWeekend
                ? "bg-deep ring-1 ring-marigold/25 shadow-star-soft"
                : "bg-deep/70"
            : "bg-deep/25 text-muted/50";

          // Constellation band: dotted connector toward the next day in the span.
          const connectsRight = lw && cell.iso < lw.end;

          return (
            <div
              key={cell.iso}
              className={`relative aspect-square rounded-xl p-1.5 sm:aspect-[4/3] sm:p-2 ${base}`}
            >
              <div className="flex items-start justify-between">
                <span
                  className={`font-numeric text-sm ${
                    cell.iso === today
                      ? "inline-grid h-6 w-6 place-items-center rounded-full bg-marigold font-bold text-ink"
                      : isWeekendGlow
                        ? "text-marigold"
                        : ""
                  }`}
                >
                  {cell.dayOfMonth}
                </span>
                {isWeekendGlow && (
                  <span
                    aria-hidden
                    className="text-[10px] text-marigold drop-shadow-[0_0_6px_rgba(255,182,72,0.8)]"
                  >
                    ✦
                  </span>
                )}
              </div>

              {info?.holiday && (
                <p
                  className="mt-0.5 hidden truncate text-[10px] leading-tight text-rose sm:block"
                  title={info.holiday}
                >
                  {info.holiday}
                </p>
              )}

              {lw && cell.iso === lw.start && (
                <span className="absolute -top-2 left-1.5 rounded-full bg-marigold px-1.5 py-px font-numeric text-[9px] font-bold uppercase tracking-wide text-ink">
                  {lw.label}
                </span>
              )}

              {teaser && (
                <p className="absolute inset-x-1.5 bottom-1 hidden truncate text-[10px] text-sky sm:block">
                  {teaser.emoji} {teaser.name}
                </p>
              )}

              {connectsRight && (
                <span
                  aria-hidden
                  className="absolute -right-1.5 top-1/2 hidden w-3 -translate-y-1/2 border-t border-dotted border-marigold/70 sm:block"
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
