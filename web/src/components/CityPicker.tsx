import { useEffect, useState } from "react";
import { fetchCities } from "../lib/api";
import type { City } from "../lib/types";

function haversineKm(
  [lat1, lon1]: [number, number],
  [lat2, lon2]: [number, number],
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

interface CityPickerProps {
  open: boolean;
  onPick: (city: City) => void;
  onClose?: () => void;
}

export function CityPicker({ open, onPick, onClose }: CityPickerProps) {
  const [cities, setCities] = useState<City[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchCities()
      .then(({ cities }) => setCities(cities))
      .catch(() => setCities([]));
  }, [open]);

  const autoDetect = () => {
    if (!navigator.geolocation || cities.length === 0) {
      setDetectError("Location isn't available — pick your city below.");
      return;
    }
    setDetecting(true);
    setDetectError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here: [number, number] = [
          pos.coords.latitude,
          pos.coords.longitude,
        ];
        const nearest = [...cities].sort(
          (a, b) => haversineKm(here, a.coords) - haversineKm(here, b.coords),
        )[0];
        setDetecting(false);
        onPick(nearest);
      },
      () => {
        setDetecting(false);
        setDetectError("Couldn't detect location — pick your city below.");
      },
      { timeout: 8000 },
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <button
        aria-label="Close city picker"
        onClick={onClose}
        className="absolute inset-0 bg-ink/70 backdrop-blur-sm"
        disabled={!onClose}
      />
      <div className="relative w-full max-w-lg animate-fade-up rounded-card bg-deep p-6 shadow-drawer ring-1 ring-white/10 sm:p-8">
        <h2 className="font-display text-2xl font-bold">
          Where do you start from?
        </h2>
        <p className="mt-1 text-sm text-muted">
          Bike and bus trips are planned from your home city.
        </p>

        <button
          onClick={autoDetect}
          disabled={detecting}
          className="mt-5 w-full rounded-xl bg-marigold/15 px-4 py-3 font-medium text-marigold ring-1 ring-marigold/40 transition hover:bg-marigold/25 disabled:opacity-60"
        >
          {detecting ? "Detecting…" : "📍 Auto-detect my location"}
        </button>
        {detectError && (
          <p className="mt-2 text-sm text-rose">{detectError}</p>
        )}

        <div className="mt-5 grid grid-cols-4 gap-3">
          {cities.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c)}
              className="group flex flex-col items-center gap-1.5 rounded-xl bg-raise p-3 ring-1 ring-white/5 transition hover:-translate-y-0.5 hover:ring-marigold/60"
            >
              <span
                aria-hidden
                className="text-2xl transition group-hover:scale-110"
              >
                {c.emoji}
              </span>
              <span className="text-center text-xs leading-tight">
                {c.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
