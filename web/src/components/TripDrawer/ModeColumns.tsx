import type { Recommendations, TravelMode } from "../../lib/types";
import { DestinationCard } from "./DestinationCard";

export const MODE_META: Record<
  TravelMode,
  { label: string; emoji: string; color: string }
> = {
  flight: { label: "Flight", emoji: "✈️", color: "text-sky" },
  bike: { label: "Bike", emoji: "🏍️", color: "text-jade" },
  bus: { label: "Bus & friends", emoji: "🚌", color: "text-marigold" },
};

const MODES: TravelMode[] = ["flight", "bike", "bus"];

interface ModeColumnsProps {
  data: Recommendations;
  scope: "india" | "international";
  onOpenDestination?: (id: string) => void;
  onRefreshMode?: (mode: TravelMode | "international") => void;
}

export function ModeColumns({
  data,
  scope,
  onOpenDestination,
  onRefreshMode,
}: ModeColumnsProps) {
  if (scope === "international") {
    return (
      <div>
        <ColumnHeader
          label="Flight"
          emoji="✈️"
          color="text-sky"
          onRefresh={() => onRefreshMode?.("international")}
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {data.international.map((pick) => (
            <div key={pick.destination.id} className="animate-fade-up">
              <DestinationCard pick={pick} onOpen={onOpenDestination} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {MODES.map((mode) => (
        <div key={mode}>
          <ColumnHeader
            label={MODE_META[mode].label}
            emoji={MODE_META[mode].emoji}
            color={MODE_META[mode].color}
            onRefresh={() => onRefreshMode?.(mode)}
          />
          <div className="mt-3 space-y-4">
            {data.india[mode].slice(0, 1).map((pick) => (
              <div key={pick.destination.id} className="animate-fade-up">
                <DestinationCard pick={pick} onOpen={onOpenDestination} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ColumnHeader({
  label,
  emoji,
  color,
  onRefresh,
}: {
  label: string;
  emoji: string;
  color: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <h4
        className={`font-numeric text-xs font-bold uppercase tracking-widest ${color}`}
      >
        <span aria-hidden className="mr-1.5">
          {emoji}
        </span>
        {label}
      </h4>
      <button
        aria-label={`Refresh ${label} pick`}
        onClick={onRefresh}
        className="grid h-7 w-7 place-items-center rounded-full bg-raise text-muted transition hover:rotate-180 hover:text-starlight"
      >
        ↻
      </button>
    </div>
  );
}
