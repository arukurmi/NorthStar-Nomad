import { useEffect, useState } from "react";
import { fetchVibes } from "../../lib/api";
import type { BudgetTier, TripFilters, Vibe } from "../../lib/types";

const BUDGETS: { value: BudgetTier | null; label: string }[] = [
  { value: null, label: "✨ Any budget" },
  { value: "₹", label: "💰 Budget" },
  { value: "₹₹", label: "💳 Mid-range" },
  { value: "₹₹₹", label: "💎 Splurge" },
];

interface FilterBarProps {
  filters: TripFilters;
  onChange: (filters: TripFilters) => void;
}

export function FilterBar({ filters, onChange }: FilterBarProps) {
  const [vibes, setVibes] = useState<Vibe[]>([]);

  useEffect(() => {
    fetchVibes()
      .then(({ vibes }) => setVibes(vibes))
      .catch(() => setVibes([]));
  }, []);

  const toggleVibe = (id: string) => {
    const next = filters.vibes.includes(id)
      ? filters.vibes.filter((v) => v !== id)
      : [...filters.vibes, id];
    onChange({ ...filters, vibes: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {BUDGETS.map((b) => (
          <button
            key={b.label}
            onClick={() => onChange({ ...filters, budget: b.value })}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
              filters.budget === b.value
                ? "bg-marigold text-ink ring-marigold"
                : "bg-raise text-muted ring-white/10 hover:text-starlight"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {vibes.map((v) => (
          <button
            key={v.id}
            onClick={() => toggleVibe(v.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
              filters.vibes.includes(v.id)
                ? "bg-jade text-ink ring-jade"
                : "bg-raise text-muted ring-white/10 hover:text-starlight"
            }`}
          >
            {v.emoji} {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}
