import { Link } from "react-router-dom";
import type { AiErrorCode } from "../../lib/types";

/**
 * What each failure means to a person, and what they can do about it.
 *
 * Cluster principle 3 is "degrade honestly": never a silent failure, never
 * fabricated placeholder content, and never a generic "something went wrong"
 * when the server has told us precisely what happened. The server's six-code
 * taxonomy exists so this table can be written — branching on a status number
 * would collapse `invalid_key` and `unauthenticated` into one 401, and
 * `provider_error` and `bad_output` into one 502, which are four different
 * conversations with the user.
 */
const COPY: Record<AiErrorCode, { headline: string; detail: string }> = {
  unauthenticated: {
    headline: "You're signed out",
    detail: "Sign in again and your trips will be waiting.",
  },
  bad_request: {
    headline: "Those dates didn't work",
    detail: "Pick the weekend again from the calendar and retry.",
  },
  not_found: {
    headline: "That trip isn't in your plans any more",
    detail: "It may have been removed from another tab.",
  },
  no_key: {
    headline: "No AI key yet",
    detail: "Add one in your profile to use this.",
  },
  invalid_key: {
    headline: "Your provider rejected that key",
    detail:
      "It may have been revoked or rotated. Paste a fresh one in your profile — you are still signed in here.",
  },
  insufficient_credit: {
    headline: "That account is out of credit",
    detail:
      "Top up with your provider, or add a key for a different one. We never bill you; this is between you and them.",
  },
  rate_limited: {
    headline: "Too many requests just now",
    detail: "Give it a moment and try again.",
  },
  provider_error: {
    headline: "Couldn't reach your provider",
    detail: "Usually a passing outage on their side. Try again shortly.",
  },
  bad_output: {
    headline: "The answer didn't fit the format",
    detail:
      "We asked twice and got something we couldn't use. Retrying often works — models vary run to run.",
  },
};

interface AiErrorNoteProps {
  code: AiErrorCode;
  /** The server's own message. Safe to render verbatim — it never carries a key. */
  message?: string;
  /** Seconds. Only ever present for `rate_limited`. */
  retryAfter?: number;
  onRetry?: () => void;
}

export function AiErrorNote({
  code,
  message,
  retryAfter,
  onRetry,
}: AiErrorNoteProps) {
  const copy = COPY[code];
  // The two codes a retry button cannot help with: one needs a key added, the
  // other needs a new session. Offering "Try again" there is a lie.
  const retryable = code !== "no_key" && code !== "unauthenticated";
  const needsProfile = code === "invalid_key" || code === "insufficient_credit";

  return (
    <div
      role="alert"
      className="animate-fade-up rounded-card bg-deep/60 p-5 ring-1 ring-rose/30"
    >
      <p className="font-numeric text-xs uppercase tracking-widest text-rose">
        ✦ {copy.headline}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-starlight/85">
        {copy.detail}
      </p>
      {message && (
        <p className="mt-2 font-numeric text-xs leading-relaxed text-muted">
          {message}
          {retryAfter !== undefined && ` · retry in ${retryAfter}s`}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-raise px-4 py-1.5 text-sm font-medium text-starlight transition hover:brightness-125"
          >
            Try again
          </button>
        )}
        {needsProfile && (
          <Link
            to="/profile#ai-keys"
            className="text-sm font-semibold text-marigold underline underline-offset-2"
          >
            Manage your keys →
          </Link>
        )}
      </div>
    </div>
  );
}
