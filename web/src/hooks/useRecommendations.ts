import { useEffect, useState } from "react";
import { fetchRecommendations } from "../lib/api";
import type { Recommendations, TripFilters } from "../lib/types";

export function useRecommendations(
  start: string | null,
  end: string | null,
  cityId: string,
  filters: TripFilters,
) {
  const [data, setData] = useState<Recommendations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterKey = `${filters.budget ?? ""}|${filters.vibes.join(",")}`;

  useEffect(() => {
    if (!start || !end) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRecommendations(start, end, cityId, filters)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, cityId, filterKey]);

  return { data, loading, error };
}
