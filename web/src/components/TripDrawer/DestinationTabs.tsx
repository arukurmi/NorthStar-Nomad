export type DestinationTab = "overview" | "pack";

interface DestinationTabsProps {
  value: DestinationTab;
  onChange: (next: DestinationTab) => void;
}

/**
 * Pill tabs, matching the india/international switch already in TripDrawer so
 * the drawer has one tab idiom rather than two.
 *
 * F1's "Plan" tab slots in by adding one entry to TABS and one member to
 * DestinationTab — deliberately, since F1 and F2 are being built independently
 * and whichever lands second should not have to restructure the first.
 */
const TABS: Array<{ id: DestinationTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "pack", label: "✦ Pack" },
];

export function DestinationTabs({ value, onChange }: DestinationTabsProps) {
  return (
    // Deliberately NOT role="tablist"/role="tab". Those roles promise an
    // aria-controls target, a role="tabpanel", and APG arrow-key navigation
    // with a roving tabindex — none of which this has. Announcing "tab, 1 of 2"
    // and then offering nothing to navigate to is worse than plain buttons.
    // It behaves like a toggle group, so it is described as one.
    <div
      aria-label="Destination sections"
      className="inline-flex max-w-full flex-wrap rounded-full bg-ink p-1 font-numeric text-xs uppercase tracking-wide"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={`rounded-full px-4 py-1.5 transition ${
            value === tab.id
              ? "bg-marigold font-bold text-ink"
              : "text-muted hover:text-starlight"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
