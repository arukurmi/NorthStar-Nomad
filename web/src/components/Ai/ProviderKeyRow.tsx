import { useEffect, useRef, useState } from "react";
import { AiClientError, PROVIDER_META, formatModel, type AiClient } from "../../lib/ai";
import type { AiErrorCode, AiKeyPublic, ProviderId } from "../../lib/types";
import { AddKeyForm } from "./AddKeyForm";
import { ProviderMark } from "./ProviderMark";

/** §7.4 — the four states a row can be in, plus the transient delete. */
type KeyRowState =
  | { status: "unconfigured" }
  | { status: "validating"; last4?: string }
  | { status: "connected"; key: AiKeyPublic }
  | { status: "error"; code: AiErrorCode; message: string; key?: AiKeyPublic }
  | { status: "deleting"; key: AiKeyPublic };

interface ProviderKeyRowProps {
  provider: ProviderId;
  /** What the server says is configured, or null. */
  entry: AiKeyPublic | null;
  client: AiClient;
  /** Re-reads the key list after any change, so the server stays the truth. */
  onChanged: () => Promise<void> | void;
  /** Called when a save fails because the session, not the key, is gone. */
  onSessionLost: () => void;
}

/**
 * Copy is driven by the error `code`, never by echoing the server's string.
 * The server writes for a developer reading a log; this writes for someone who
 * just pasted something and wants to know whether it worked.
 */
function errorCopy(err: AiClientError, provider: ProviderId): string {
  const meta = PROVIDER_META[provider];
  switch (err.code) {
    case "invalid_key":
      return "That key was rejected. Check you copied the whole thing.";
    case "insufficient_credit":
      return "The key works, but the account is out of credit.";
    case "rate_limited":
      return `Rate limited — try again in ${err.retryAfter ?? 30}s.`;
    case "provider_error":
      return `Couldn't reach ${meta.label}. Try again in a moment.`;
    case "bad_request":
      return `That doesn't look like a ${meta.label} key (${meta.keyHint}).`;
    case "not_found":
      return "That key is already gone.";
    case "unauthenticated":
      return "Your session expired — sign in again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

function fmtValidated(iso: string | null): string {
  if (!iso) return "not yet validated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not yet validated";
  return `validated ${d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  })}`;
}

const PILL_BASE =
  "rounded-full px-3 py-1 text-xs font-medium ring-1 whitespace-nowrap";

/**
 * `entry` is a brand-new object after every list refresh, so an identity check
 * says "changed" even when the server said exactly the same thing. Compare the
 * value instead: a refresh triggered by a *different* row must not disturb this
 * one — least of all wipe an error the user is still reading.
 */
function signatureOf(entry: AiKeyPublic | null): string | null {
  if (!entry) return null;
  return [
    entry.provider,
    entry.last4,
    entry.model,
    entry.validatedAt ?? "",
    entry.preferred ? "1" : "0",
  ].join("|");
}

export function ProviderKeyRow({
  provider,
  entry,
  client,
  onChanged,
  onSessionLost,
}: ProviderKeyRowProps) {
  const meta = PROVIDER_META[provider];
  const [state, setState] = useState<KeyRowState>(() =>
    entry ? { status: "connected", key: entry } : { status: "unconfigured" },
  );
  // Kept alongside the state machine rather than inside it: "replacing a
  // connected key" is the form being open over a row that still has a key, and
  // folding that into `unconfigured` would lose the key we still want to show.
  const [formOpen, setFormOpen] = useState(entry === null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The last server value this row actually applied. The initial state above
  // already reflects `entry`, so mount starts in sync.
  const syncedTo = useRef(signatureOf(entry));

  // The server's list is the source of truth; re-sync whenever what it says
  // about *this* provider changes, except while this row has a request of its
  // own in flight — that request's handler lands on a terminal state itself,
  // and re-running this effect on `state.status` picks the sync back up.
  useEffect(() => {
    const signature = signatureOf(entry);
    if (signature === syncedTo.current) return;
    if (state.status === "validating" || state.status === "deleting") return;
    syncedTo.current = signature;
    setState(entry ? { status: "connected", key: entry } : { status: "unconfigured" });
    if (entry) setConfirmingDelete(false);
    else setFormOpen(true);
  }, [entry, state.status]);

  const busy = state.status === "validating" || state.status === "deleting";
  // `validating` falls back to `entry` on purpose: replacing a key should keep
  // showing the old one until the new one is accepted. `unconfigured` must not,
  // or the row would keep offering to delete a key it has just deleted, in the
  // window before the refreshed list arrives.
  const current: AiKeyPublic | null =
    state.status === "connected" || state.status === "deleting"
      ? state.key
      : state.status === "error"
        ? (state.key ?? null)
        : state.status === "validating"
          ? entry
          : null;

  const save = async (apiKey: string, model: string | undefined) => {
    setState({ status: "validating", last4: apiKey.slice(-4) });
    try {
      const key = await client.saveKey({ provider, apiKey, model });
      // Land on `connected` from the save response, so the row settles even if
      // the follow-up list refresh is slow or fails.
      setState({ status: "connected", key });
      setFormOpen(false);
      await onChanged();
    } catch (err) {
      const e = err instanceof AiClientError ? err : new AiClientError("provider_error", "");
      setState({
        status: "error",
        code: e.code,
        message: errorCopy(e, provider),
        key: current ?? undefined,
      });
      // A rejected API key must never end the session — but a genuinely dead
      // session still should. The refresh below runs with the default 401
      // handling, which signs the user out for real.
      if (e.code === "unauthenticated") onSessionLost();
    }
  };

  const remove = async () => {
    if (!current) return;
    setConfirmingDelete(false);
    setState({ status: "deleting", key: current });
    try {
      await client.deleteKey(provider);
      // Land on `unconfigured` here, before the refresh — same reason as
      // `save()`. The refresh flips `entry` to null, and the sync effect will
      // not touch a row that is still `deleting`, so waiting for it would
      // strand this row on "Removing…" with the deleted key still on screen.
      setState({ status: "unconfigured" });
      setFormOpen(true);
      await onChanged();
    } catch (err) {
      const e = err instanceof AiClientError ? err : new AiClientError("provider_error", "");
      setState({
        status: "error",
        code: e.code,
        message: errorCopy(e, provider),
        key: current,
      });
    }
  };

  const makeDefault = async () => {
    try {
      await client.setPreferred(provider);
      await onChanged();
    } catch {
      // A failed preference change leaves the row exactly as it was; the next
      // refresh shows the truth. Not worth a scary error state.
    }
  };

  return (
    <li className="rounded-xl bg-raise p-4 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderMark provider={provider} busy={state.status === "validating"} />
          <div className="min-w-0">
            <p className="font-display font-semibold">
              {meta.label}
              {current?.preferred && state.status === "connected" && (
                <span className="ml-2 align-middle font-numeric text-[10px] uppercase tracking-widest text-marigold">
                  ✦ Default
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate font-numeric text-xs text-muted">
              {current
                ? `····${current.last4} · ${current.model} · ${fmtValidated(current.validatedAt)}`
                : state.status === "validating" && state.last4
                  ? `····${state.last4} · asking ${meta.label} if this key works`
                  : `No key yet · ${meta.keyHint}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {state.status === "unconfigured" && (
            <span className={`${PILL_BASE} bg-raise text-muted ring-white/5`}>
              Not connected
            </span>
          )}
          {state.status === "validating" && (
            <span className={`${PILL_BASE} bg-sky/15 text-sky ring-sky/40`}>
              Checking…
            </span>
          )}
          {state.status === "deleting" && (
            <span className={`${PILL_BASE} bg-raise text-muted ring-white/5`}>
              Removing…
            </span>
          )}
          {state.status === "connected" && (
            <span className={`${PILL_BASE} bg-jade/15 text-jade ring-jade/40`}>
              ✓ Connected — {formatModel(state.key.model)}
            </span>
          )}
          {state.status === "error" && (
            <span className={`${PILL_BASE} bg-rose/15 text-rose ring-rose/40`}>
              ✗ {state.code === "invalid_key" ? "That key was rejected" : "Didn't work"}
            </span>
          )}

          {state.status === "connected" && !state.key.preferred && (
            <button
              onClick={makeDefault}
              className="rounded-full bg-raise px-3 py-1 text-xs text-muted ring-1 ring-white/5 transition hover:text-starlight"
            >
              Make default
            </button>
          )}
          {current && !formOpen && !busy && (
            <button
              onClick={() => setFormOpen(true)}
              className="rounded-full bg-raise px-3 py-1 text-xs text-muted ring-1 ring-white/5 transition hover:text-starlight"
            >
              Replace key
            </button>
          )}
          {current && !busy && (
            <button
              aria-label={`Remove ${meta.label} key`}
              onClick={() => setConfirmingDelete(true)}
              className="grid h-7 w-7 place-items-center rounded-full text-muted transition hover:bg-rose/20 hover:text-rose"
            >
              🗑
            </button>
          )}
        </div>
      </div>

      {state.status === "error" && (
        <p role="status" className="mt-3 text-sm text-rose">
          ✗ {state.message}
        </p>
      )}

      {confirmingDelete && current && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink/50 p-3 ring-1 ring-rose/30">
          <p className="flex-1 text-sm text-muted">
            Remove your {meta.label} key ending ····{current.last4}? Anything
            that needs it will stop working until you add it again.
          </p>
          <button
            onClick={remove}
            className="rounded-full bg-rose/15 px-3 py-1 text-xs font-medium text-rose ring-1 ring-rose/40 transition hover:bg-rose/25"
          >
            Yes, remove it
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="rounded-full bg-raise px-3 py-1 text-xs text-muted transition hover:text-starlight"
          >
            Keep it
          </button>
        </div>
      )}

      {formOpen && (
        <AddKeyForm
          provider={provider}
          busy={busy}
          onEdit={() =>
            // Typing is the user answering the error — clear it rather than
            // leaving a red pill sitting over a field they are already fixing.
            setState((prev) =>
              prev.status === "error"
                ? prev.key
                  ? { status: "connected", key: prev.key }
                  : { status: "unconfigured" }
                : prev,
            )
          }
          onSubmit={save}
          onCancel={current ? () => setFormOpen(false) : undefined}
        />
      )}
    </li>
  );
}
