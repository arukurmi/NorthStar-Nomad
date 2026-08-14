import { Link } from "react-router-dom";
import type { AiFeature } from "../../lib/types";

const PITCH: Record<AiFeature, string> = {
  itinerary: "Turn these dates into a day-by-day plan.",
  packing: "Get a packing list built from the actual forecast.",
  budget: "See what this trip is likely to cost, line by line.",
  search: "Describe the trip you want in your own words.",
};

interface KeyPromptProps {
  feature: AiFeature;
  /** Overrides the default per-feature pitch. */
  headline?: string;
}

/**
 * The empty state every AI feature renders when the user has no key yet
 * (`428 no_key`). One component, so the ask reads the same everywhere and the
 * honesty about who pays is never quietly dropped from one of them.
 */
export function KeyPrompt({ feature, headline }: KeyPromptProps) {
  return (
    <div className="animate-fade-up rounded-card bg-deep/60 p-5 ring-1 ring-marigold/25">
      <p className="font-numeric text-xs uppercase tracking-widest text-marigold">
        ✦ Bring your own key
      </p>
      <p className="mt-2 font-display text-lg font-semibold">
        {headline ?? PITCH[feature]}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        This one runs on your own AI provider account — Anthropic, Gemini or
        OpenAI. You pay them directly at cost, we add nothing, and your key is
        encrypted before it's stored.
      </p>
      <Link
        to="/profile#ai-keys"
        className="mt-4 inline-block rounded-full bg-marigold px-4 py-1.5 text-sm font-bold text-ink transition hover:brightness-110"
      >
        Add your key →
      </Link>
    </div>
  );
}
