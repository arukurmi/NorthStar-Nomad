interface PackingItemRowProps {
  itemKey: string;
  label: string;
  qty: number;
  reason?: string;
  checked: boolean;
  /** False when no saved trip matches — the row explains itself elsewhere. */
  tickable: boolean;
  pending: boolean;
  onToggle: (itemKey: string, checked: boolean) => void;
}

/**
 * One checkbox.
 *
 * The whole row is the label element, so the tap target is the full width and
 * at least 44px tall — this is used one-handed, standing over an open bag, and
 * a 16px checkbox is not a target.
 *
 * `reason` renders as quiet secondary text *under* the item rather than as a
 * tooltip. The PRD is explicit about this and it is right: the reason is the
 * part that teaches ("thermals — nights drop to 4°C"), and a tooltip hides it
 * from every touch device, which is most of them.
 */
export function PackingItemRow({
  itemKey,
  label,
  qty,
  reason,
  checked,
  tickable,
  pending,
  onToggle,
}: PackingItemRowProps) {
  return (
    <li>
      <label
        className={`flex min-h-[44px] w-full cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition ${
          tickable ? "hover:bg-raise/60" : "cursor-default"
        } ${pending ? "opacity-60" : ""}`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!tickable || pending}
          onChange={(e) => onToggle(itemKey, e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-marigold"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <span
              className={`font-medium leading-snug ${
                checked ? "text-muted line-through" : "text-starlight"
              }`}
            >
              {label}
            </span>
            {/* Only shown above one: "1 ×" on every row is noise that makes
                the rows that genuinely scale harder to spot. */}
            {qty > 1 && (
              <span className="shrink-0 rounded-full bg-raise px-2 py-0.5 font-numeric text-[11px] font-bold text-marigold">
                {qty} ×
              </span>
            )}
          </span>
          {reason && (
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              {reason}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}
