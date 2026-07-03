import { holidayByDate } from "../data/holidays.js";

export interface LongWeekend {
  /** ISO date of the first off day. */
  start: string;
  /** ISO date of the last off day. */
  end: string;
  days: number;
  label: string;
  holidayName?: string;
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function isOffDay(d: Date): { off: boolean; holiday?: string } {
  const dow = d.getUTCDay();
  const holiday = holidayByDate.get(toIso(d));
  return { off: dow === 0 || dow === 6 || holiday !== undefined, holiday };
}

/**
 * Find spans of 3+ consecutive off days (weekends joined by holidays)
 * that intersect the given month. Month is 1-based.
 */
export function findLongWeekends(year: number, month: number): LongWeekend[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  // Scan a padded window so spans straddling month edges are caught whole.
  const cursor = new Date(first);
  cursor.setUTCDate(cursor.getUTCDate() - 6);
  const stop = new Date(last);
  stop.setUTCDate(stop.getUTCDate() + 6);

  const spans: LongWeekend[] = [];
  let spanStart: Date | null = null;
  let spanHolidays: string[] = [];

  const closeSpan = (endExclusive: Date) => {
    if (!spanStart) return;
    const end = new Date(endExclusive);
    end.setUTCDate(end.getUTCDate() - 1);
    const days =
      Math.round((end.getTime() - spanStart.getTime()) / 86_400_000) + 1;
    if (days >= 3 && end >= first && spanStart <= last) {
      spans.push({
        start: toIso(spanStart),
        end: toIso(end),
        days,
        label: `${days}-day weekend`,
        holidayName: spanHolidays[0],
      });
    }
    spanStart = null;
    spanHolidays = [];
  };

  while (cursor <= stop) {
    const { off, holiday } = isOffDay(cursor);
    if (off) {
      if (!spanStart) spanStart = new Date(cursor);
      if (holiday) spanHolidays.push(holiday);
    } else {
      closeSpan(cursor);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  closeSpan(cursor);

  return spans;
}
