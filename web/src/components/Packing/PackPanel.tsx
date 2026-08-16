import { Link } from "react-router-dom";
import { usePacking } from "../../hooks/usePacking";
import { useAuth } from "../../lib/auth";
import { KeyPrompt } from "../Ai/KeyPrompt";
import { AiErrorNote } from "../Ai/AiErrorNote";
import { PackingCategory } from "./PackingCategory";
import { PackingProgress } from "./PackingProgress";
import { PackingSkeleton } from "./PackingSkeleton";
import type { TravelMode } from "../../lib/types";

interface PackPanelProps {
  destinationId: string;
  destinationName: string;
  range: { start: string; end: string };
  mode: TravelMode;
  /** When the caller already knows the saved trip, the panel restores for free. */
  tripId?: number;
}

/** "just now" / "3 days ago" — enough for "is this stale?", nothing more. */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The Pack tab's body. Every branch the server can put us in has a rendering
 * here, and none of them is a blank panel.
 */
export function PackPanel({
  destinationId,
  destinationName,
  range,
  mode,
  tripId,
}: PackPanelProps) {
  const { user } = useAuth();
  const { state, generate, toggle, pending, tickError, restoring } = usePacking({
    destinationId,
    start: range.start,
    end: range.end,
    mode,
    tripId,
  });

  if (!user) {
    return (
      <p className="rounded-card bg-deep/60 p-5 text-sm text-muted">
        <Link to="/login" className="font-semibold text-marigold underline">
          Sign in
        </Link>{" "}
        to build a packing list for {destinationName}.
      </p>
    );
  }

  // 428 is not an error state, it is a different offer. Rendering it through
  // AiErrorNote would put a red alert in front of someone who has simply not
  // set the feature up yet.
  if (state.status === "error" && state.code === "no_key") {
    return <KeyPrompt feature="packing" />;
  }

  if (state.status === "error") {
    return (
      <AiErrorNote
        code={state.code}
        message={state.message}
        retryAfter={state.retryAfter}
        onRetry={generate}
      />
    );
  }

  // The free restore looks the same as a generation while it runs, which is
  // honest — both end in a list — and it stops the idle CTA flashing on screen
  // for the moment before a saved list loads.
  if (state.status === "generating" || restoring) return <PackingSkeleton />;

  if (state.status === "idle") {
    return (
      <div className="animate-fade-up rounded-card bg-deep/60 p-5 ring-1 ring-marigold/25">
        <p className="font-numeric text-xs uppercase tracking-widest text-marigold">
          ✦ Pack for this trip
        </p>
        <p className="mt-2 text-sm leading-relaxed text-starlight/85">
          Built from this month's actual temperatures for {destinationName},
          how long you're going, and the fact you're travelling by {mode}.
        </p>
        <button
          type="button"
          onClick={generate}
          className="mt-4 rounded-full bg-marigold px-4 py-1.5 text-sm font-bold text-ink transition hover:brightness-110"
        >
          Build my packing list →
        </button>
      </div>
    );
  }

  const { packing, trip, cached, generatedAt } = state;
  const tickable = trip !== null;
  const checked = trip?.checked ?? {};
  // The parser allows zero mode-category matches when the model ignored the
  // dictated heading, so falling back to the first section keeps something
  // open. Every section collapsed is a wall of headers with nothing in it.
  const modeIndex = packing.categories.findIndex((c) => c.modeCategory);
  const openIndex = modeIndex === -1 ? 0 : modeIndex;

  return (
    <div className="animate-fade-up space-y-3">
      <PackingProgress
        checked={trip?.checkedCount ?? 0}
        total={trip?.total ?? 0}
        tickable={tickable}
      />

      <p className="text-sm leading-relaxed text-starlight/85">
        {packing.summary}
      </p>

      {tickError && (
        <p role="alert" className="text-xs text-rose">
          {tickError}
        </p>
      )}

      {packing.categories.map((category, index) => (
        <PackingCategory
          key={category.name}
          name={category.name}
          modeCategory={category.modeCategory}
          defaultOpen={index === openIndex}
          items={category.items}
          checked={checked}
          tickable={tickable}
          pending={pending}
          onToggle={toggle}
        />
      ))}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        {/* Honesty about age and cost, per cluster principle 5: a cached answer
            may be days old and the user paid nothing for it. Saying so is what
            makes the saving visible rather than invisible. */}
        <p className="min-w-0 font-numeric text-xs text-muted">
          {cached
            ? `Generated ${ago(generatedAt)} · free, from cache`
            : "Generated just now · billed to your provider"}
        </p>
        <button
          type="button"
          onClick={generate}
          className="shrink-0 rounded-full bg-raise px-3 py-1.5 font-numeric text-xs text-muted transition hover:text-starlight"
        >
          ↻ Rebuild
        </button>
      </div>
    </div>
  );
}
