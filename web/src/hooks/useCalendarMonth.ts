import { useEffect, useState } from "react";
import { fetchCalendarMonth } from "../lib/api";
import type { CalendarMonth } from "../lib/types";

export interface CalendarMonthState {
  data: CalendarMonth | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useCalendarMonth(
  year: number,
  month: number,
): CalendarMonthState {
  const [data, setData] = useState<CalendarMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCalendarMonth(year, month)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year, month, attempt]);

  return {
    data,
    loading,
    error,
    reload: () => setAttempt((a) => a + 1),
  };
}
