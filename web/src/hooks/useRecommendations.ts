import { useEffect, useState } from "react";
import { fetchRecommendations } from "../lib/api";
import type { Recommendations } from "../lib/types";

export function useRecommendations(
  start: string | null,
  end: string | null,
  seed: number,
) {
  const [data, setData] = useState<Recommendations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!start || !end) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRecommendations(start, end, seed)
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
  }, [start, end, seed]);

  return { data, loading, error };
}
