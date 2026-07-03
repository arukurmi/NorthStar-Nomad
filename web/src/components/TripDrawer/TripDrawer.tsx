import { useState } from "react";
import type { SelectedRange } from "../../lib/selection";
import { formatRange } from "../../lib/selection";
import { useRecommendations } from "../../hooks/useRecommendations";
import type { Scope } from "../../lib/types";
import { ModeColumns } from "./ModeColumns";

interface TripDrawerProps {
  range: SelectedRange | null;
  onClose: () => void;
}

export function TripDrawer({ range, onClose }: TripDrawerProps) {
  const [scope, setScope] = useState<Scope>("india");
  const { data, loading, error } = useRecommendations(
    range?.start ?? null,
    range?.end ?? null,
    0,
  );

  return (
    <>
      {range && (
        <button
          aria-label="Close trip panel"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-ink/60 backdrop-blur-sm"
        />
      )}
      <aside
        aria-hidden={!range}
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-3xl transform overflow-y-auto bg-deep shadow-drawer transition-transform duration-300 ease-out ${
          range ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {range && (
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-numeric text-xs uppercase tracking-widest text-marigold">
                  {range.label}
                </p>
                <h3 className="mt-1 font-display text-3xl font-bold">
                  {formatRange(range)}
                </h3>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="grid h-9 w-9 place-items-center rounded-full bg-raise text-muted transition hover:text-starlight"
              >
                ✕
              </button>
            </div>

            <div className="mt-6 inline-flex rounded-full bg-ink p-1 font-numeric text-xs uppercase tracking-wide">
              {(["india", "international"] as Scope[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`rounded-full px-4 py-1.5 transition ${
                    scope === s
                      ? "bg-marigold font-bold text-ink"
                      : "text-muted hover:text-starlight"
                  }`}
                >
                  {s === "india" ? "India" : "International"}
                </button>
              ))}
            </div>

            <div className="mt-6">
              {error ? (
                <p className="text-rose">
                  Couldn't load picks — check the server and try again.
                </p>
              ) : loading && !data ? (
                <p className="text-muted">Reading the stars…</p>
              ) : data ? (
                <ModeColumns data={data} scope={scope} />
              ) : null}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
