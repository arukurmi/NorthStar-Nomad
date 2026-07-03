export interface MonthCell {
  /** ISO date YYYY-MM-DD */
  iso: string;
  dayOfMonth: number;
  inMonth: boolean;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoOf(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Build a Monday-first grid of weeks covering the month,
 * padded with leading/trailing days from neighbouring months.
 */
export function monthMatrix(year: number, month: number): MonthCell[][] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // Monday-first offset: Sun(0) -> 6, Mon(1) -> 0, ...
  const lead = (firstDow + 6) % 7;

  const firstIso = isoOf(year, month, 1);
  const cells: MonthCell[] = [];
  for (let i = -lead; cells.length % 7 !== 0 || i <= daysInMonth - 1; i++) {
    const iso = addDays(firstIso, i);
    cells.push({
      iso,
      dayOfMonth: Number(iso.slice(8, 10)),
      inMonth: i >= 0 && i < daysInMonth,
    });
  }

  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}
