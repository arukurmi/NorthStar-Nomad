import type { CalendarMonth, LongWeekend, Teaser } from "../../lib/types";
import {
  MONTH_NAMES,
  WEEKDAY_LABELS,
  addDays,
  dayOfWeek,
  monthMatrix,
  todayIso,
} from "../../lib/dates";

interface MonthGridProps {
  year: number;
  month: number;
  calendar: CalendarMonth | null;
  highlightIso?: string | null;
  /** Range being built or already selected — painted as a connected band. */
  rangePaint?: { start: string; end: string } | null;
  rangeMode?: boolean;
  onSelectDay?: (iso: string) => void;
  onHoverDay?: (iso: string | null) => void;
}

function longWeekendFor(
  iso: string,
  longWeekends: LongWeekend[],
): LongWeekend | undefined {
  return longWeekends.find((lw) => iso >= lw.start && iso <= lw.end);
}

function teaserFor(
  iso: string,
  teasers: Record<string, Teaser>,
  lw: LongWeekend | undefined,
): Teaser | undefined {
  if (teasers[iso]) return teasers[iso];
  if (lw && teasers[lw.start]) return teasers[lw.start];
  // Sundays share the Saturday teaser.
  if (dayOfWeek(iso) === 0) return teasers[addDays(iso, -1)];
  return undefined;
}

export function MonthGrid({
  year,
  month,
  calendar,
  highlightIso,
  rangePaint,
  rangeMode,
  onSelectDay,
  onHoverDay,
}: MonthGridProps) {
  const weeks = monthMatrix(year, month);
  const today = todayIso();
  const dayInfo = new Map(calendar?.days.map((d) => [d.date, d]) ?? []);
  const longWeekends = calendar?.longWeekends ?? [];
  const teasers = calendar?.teasers ?? {};

  const inRange = (iso: string) =>
    rangePaint !== null &&
    rangePaint !== undefined &&
    iso >= rangePaint.start &&
    iso <= rangePaint.end;

  return (
    <section
      aria-label={`${MONTH_NAMES[month - 1]} ${year}`}
      onMouseLeave={() => onHoverDay?.(null)}
    >
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
          const teaser = cell.inMonth
            ? teaserFor(cell.iso, teasers, lw)
            : undefined;
          const ranged = cell.inMonth && inRange(cell.iso);

          const base = cell.inMonth
            ? ranged
              ? "bg-sky/20 ring-1 ring-sky/70"
              : lw
                ? "bg-raise ring-1 ring-marigold/50 shadow-star-soft"
                : info?.isWeekend
                  ? "bg-deep ring-1 ring-marigold/25 shadow-star-soft"
                  : "bg-deep/70"
            : "bg-deep/25 text-muted/50";

          const connectsRight = lw && cell.iso < lw.end && !ranged;
          const rangeConnectsRight =
            ranged && rangePaint && cell.iso < rangePaint.end;

          return (
            <button
              key={cell.iso}
              disabled={!cell.inMonth}
              onClick={() => onSelectDay?.(cell.iso)}
              onMouseEnter={() => cell.inMonth && onHoverDay?.(cell.iso)}
              className={`relative aspect-square rounded-xl p-1.5 text-left transition-all duration-200 sm:aspect-[4/3] sm:p-2 ${base} ${
                cell.iso === highlightIso
                  ? "ring-2 ring-marigold shadow-star"
                  : ""
              } ${
                cell.inMonth
                  ? rangeMode
                    ? "cursor-crosshair hover:ring-2 hover:ring-sky"
                    : "cursor-pointer hover:ring-1 hover:ring-sky/60"
                  : ""
              }`}
            >
              <div className="flex items-start justify-between">
                <span
                  className={`font-numeric text-sm ${
                    cell.iso === today
                      ? "inline-grid h-6 w-6 place-items-center rounded-full bg-marigold font-bold text-ink"
                      : ranged
                        ? "font-bold text-sky"
                        : isWeekendGlow
                          ? "text-marigold"
                          : ""
                  }`}
                >
                  {cell.dayOfMonth}
                </span>
                {isWeekendGlow && !ranged && (
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

              {lw && cell.iso === lw.start && !ranged && (
                <span className="absolute -top-2 left-1.5 z-10 rounded-full bg-marigold px-1.5 py-px font-numeric text-[9px] font-bold uppercase tracking-wide text-ink">
                  {lw.label}
                </span>
              )}

              {rangePaint && cell.iso === rangePaint.start && ranged && (
                <span className="absolute -top-2 left-1.5 z-10 rounded-full bg-sky px-1.5 py-px font-numeric text-[9px] font-bold uppercase tracking-wide text-ink">
                  Trip start
                </span>
              )}

              {teaser && !ranged && (
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
              {rangeConnectsRight && (
                <span
                  aria-hidden
                  className="absolute -right-1.5 top-1/2 hidden w-3 -translate-y-1/2 border-t-2 border-sky/70 sm:block"
                />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
