import { useState } from "react";
import { PackingItemRow } from "./PackingItemRow";
import type { PackingItem } from "../../lib/types";

interface PackingCategoryProps {
  name: string;
  modeCategory: boolean;
  items: PackingItem[];
  checked: Record<string, boolean>;
  tickable: boolean;
  pending: ReadonlySet<string>;
  onToggle: (itemKey: string, checked: boolean) => void;
}

/**
 * A collapsible section. The mode-specific one starts expanded, because it is
 * the part the user cannot have guessed — everyone knows to bring socks, and
 * nobody remembers a spare clutch cable.
 *
 * Which section that is comes from the server's `modeCategory` flag rather than
 * from matching a heading string in the client. The heading is model-authored
 * text; matching on it here would silently stop working the day the wording
 * drifts, and the symptom would be "nothing is expanded", which nobody reports.
 */
export function PackingCategory({
  name,
  modeCategory,
  items,
  checked,
  tickable,
  pending,
  onToggle,
}: PackingCategoryProps) {
  const [open, setOpen] = useState(modeCategory);
  const done = items.filter((item) => checked[item.itemKey]).length;

  return (
    <section
      className={`overflow-hidden rounded-card bg-deep/50 ring-1 ${
        modeCategory ? "ring-marigold/30" : "ring-white/5"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-raise/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`font-numeric text-xs text-muted transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          <span
            className={`truncate font-display font-semibold ${
              modeCategory ? "text-marigold" : "text-starlight"
            }`}
          >
            {name}
          </span>
        </span>
        <span className="shrink-0 font-numeric text-xs text-muted">
          {done}/{items.length}
        </span>
      </button>
      {open && (
        <ul className="animate-fade-up px-1.5 pb-2">
          {items.map((item) => (
            <PackingItemRow
              key={item.itemKey}
              itemKey={item.itemKey}
              label={item.label}
              qty={item.qty}
              reason={item.reason}
              checked={checked[item.itemKey] ?? false}
              tickable={tickable}
              pending={pending.has(item.itemKey)}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
