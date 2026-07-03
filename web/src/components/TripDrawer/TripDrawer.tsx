import type { SelectedRange } from "../../lib/selection";
import { formatRange } from "../../lib/selection";

interface TripDrawerProps {
  range: SelectedRange | null;
  onClose: () => void;
}

export function TripDrawer({ range, onClose }: TripDrawerProps) {
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
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-2xl transform overflow-y-auto bg-deep shadow-drawer transition-transform duration-300 ease-out ${
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

            <p className="mt-8 text-muted">
              Trip picks arrive in the next phase.
            </p>
          </div>
        )}
      </aside>
    </>
  );
}
