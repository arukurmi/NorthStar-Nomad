import { PROVIDER_META } from "../../lib/ai";
import type { ProviderId } from "../../lib/types";

interface ProviderMarkProps {
  provider: ProviderId;
  /** Twinkles while the key is being checked, matching the calendar's stars. */
  busy?: boolean;
}

/**
 * A provider's chip. A CSS gradient and two letters — this app ships no image
 * assets, and a vendor logo would be the only one.
 */
export function ProviderMark({ provider, busy = false }: ProviderMarkProps) {
  const meta = PROVIDER_META[provider];
  return (
    <span
      aria-hidden="true"
      style={{ background: meta.gradient }}
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl font-numeric text-xs font-bold text-ink ring-1 ring-white/10 ${
        busy ? "animate-twinkle" : ""
      }`}
    >
      {meta.initials}
    </span>
  );
}
