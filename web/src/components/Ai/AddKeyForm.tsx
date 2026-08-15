import { useState, type FormEvent } from "react";
import { PROVIDER_META } from "../../lib/ai";
import type { ProviderId } from "../../lib/types";

interface AddKeyFormProps {
  provider: ProviderId;
  /** True while the key is in flight; disables the controls. */
  busy: boolean;
  /** Shown when a previous attempt failed, so the user can fix and resubmit. */
  onEdit: () => void;
  onSubmit: (apiKey: string, model: string | undefined) => void;
  /** Present only when replacing an existing key. */
  onCancel?: () => void;
}

/**
 * The only place a plaintext API key ever exists in this app.
 *
 * It lives in one `useState` for as long as it takes the user to finish
 * pasting, and is cleared the instant it is handed to `onSubmit` — before the
 * network call even resolves. It is never lifted into context, never written
 * to `localStorage`, never put in a URL, and never logged. When this component
 * unmounts (navigating away, or the row flipping to `connected`) the state goes
 * with it.
 */
export function AddKeyForm({
  provider,
  busy,
  onEdit,
  onSubmit,
  onCancel,
}: AddKeyFormProps) {
  const meta = PROVIDER_META[provider];
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [reveal, setReveal] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = apiKey.replace(/\s+/g, "");
    if (!value || busy) return;
    // Cleared here, not in the success handler: the value has been handed
    // over, so there is no reason for this component to still be holding it
    // while the provider takes a second to answer.
    setApiKey("");
    setReveal(false);
    onSubmit(value, model.trim() || undefined);
  };

  return (
    <form onSubmit={submit} className="mt-3 w-full">
      <label
        htmlFor={`ai-api-key-${provider}`}
        className="font-numeric text-[11px] uppercase tracking-widest text-muted"
      >
        API key
      </label>
      <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <input
            id={`ai-api-key-${provider}`}
            name="ai-api-key"
            type={reveal ? "text" : "password"}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              onEdit();
            }}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={meta.keyHint}
            aria-describedby={`ai-key-hint-${provider}`}
            className="w-full rounded-xl bg-ink/60 py-2 pl-3 pr-16 font-numeric text-sm text-starlight ring-1 ring-white/10 outline-none transition placeholder:text-muted/60 focus:ring-marigold/60 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute inset-y-0 right-2 my-auto h-6 rounded-full px-2 font-numeric text-[10px] uppercase tracking-widest text-muted transition hover:text-starlight"
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>
        <input
          name="ai-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder={meta.defaultModel}
          aria-label={`Model for ${meta.label}`}
          className="rounded-xl bg-ink/60 px-3 py-2 font-numeric text-sm text-starlight ring-1 ring-white/10 outline-none transition placeholder:text-muted/60 focus:ring-marigold/60 disabled:opacity-60 sm:w-44"
        />
      </div>

      <p
        id={`ai-key-hint-${provider}`}
        className="mt-2 text-xs leading-relaxed text-muted"
      >
        Paste the whole key — it {meta.keyHint}. Leave the model blank for{" "}
        <span className="font-numeric">{meta.defaultModel}</span>.{" "}
        <a
          href={meta.consoleUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sky underline decoration-sky/40 underline-offset-2 transition hover:decoration-sky"
        >
          Get a key ↗
        </a>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy || apiKey.trim() === ""}
          className="rounded-full bg-marigold px-4 py-1.5 text-sm font-bold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Checking…" : "Save key"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full bg-raise px-4 py-1.5 text-sm text-muted transition hover:text-starlight"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
