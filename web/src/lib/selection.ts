import type { CalendarMonth } from "./types";
import { addDays, dayOfWeek } from "./dates";

export interface SelectedRange {
  start: string;
  end: string;
  label: string;
}

/**
 * Turn a clicked day into a trip range:
 * long-weekend span if the day is in one, Sat–Sun if it's a weekend day,
 * otherwise the single day itself.
 */
export function rangeForDay(
  iso: string,
  calendar: CalendarMonth | null,
): SelectedRange {
  const lw = calendar?.longWeekends.find(
    (l) => iso >= l.start && iso <= l.end,
  );
  if (lw) {
    return {
      start: lw.start,
      end: lw.end,
      label: lw.holidayName ? `${lw.label} · ${lw.holidayName}` : lw.label,
    };
  }
  const dow = dayOfWeek(iso);
  if (dow === 6) return { start: iso, end: addDays(iso, 1), label: "Weekend" };
  if (dow === 0) return { start: addDays(iso, -1), end: iso, label: "Weekend" };
  return { start: iso, end: iso, label: "Day trip" };
}

export function formatRange(range: SelectedRange): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return range.start === range.end
    ? fmt(range.start)
    : `${fmt(range.start)} – ${fmt(range.end)}`;
}
