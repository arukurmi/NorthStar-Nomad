import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { createAiClient } from "../../lib/ai";
import { useAuth } from "../../lib/auth";
import { PROVIDER_IDS, type AiKeyPublic, type UsageResponse } from "../../lib/types";
import { ProviderKeyRow } from "./ProviderKeyRow";
import { UsageSummary } from "./UsageSummary";
import { VaultNote } from "./VaultNote";

const EMPTY_USAGE: UsageResponse = {
  usage: [],
  totals: { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 },
};

/**
 * The "AI & Keys" block on the profile page: one row per provider, the vault
 * disclosure, and what has been spent so far.
 */
export function AiKeysSection() {
  const { authFetch } = useAuth();
  const client = useMemo(() => createAiClient(authFetch), [authFetch]);
  const [keys, setKeys] = useState<AiKeyPublic[]>([]);
  const [usage, setUsage] = useState<UsageResponse>(EMPTY_USAGE);
  const wrapper = useRef<HTMLElement | null>(null);
  const { hash } = useLocation();

  const refresh = useCallback(async () => {
    const [nextKeys, nextUsage] = await Promise.all([
      client.listKeys().catch(() => [] as AiKeyPublic[]),
      client.usage().catch(() => EMPTY_USAGE),
    ]);
    setKeys(nextKeys);
    setUsage(nextUsage);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // <KeyPrompt /> links to /profile#ai-keys; react-router does not scroll to a
  // hash on its own, so this is what makes that link actually land here.
  useEffect(() => {
    if (hash === "#ai-keys") {
      wrapper.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hash]);

  return (
    <section id="ai-keys" ref={wrapper} className="mt-8 scroll-mt-6">
      <h3 className="font-numeric text-xs font-bold uppercase tracking-widest text-marigold">
        ✦ AI &amp; Keys
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Northstar Nomad's AI features run on your own provider account, so you
        pay your provider directly and we never mark it up. Add a key for any
        one provider — you don't need all three.
      </p>

      <VaultNote />

      <ul className="mt-3 space-y-3">
        {PROVIDER_IDS.map((provider) => (
          <ProviderKeyRow
            key={provider}
            provider={provider}
            entry={keys.find((k) => k.provider === provider) ?? null}
            client={client}
            onChanged={refresh}
            onSessionLost={refresh}
          />
        ))}
      </ul>

      <UsageSummary usage={usage.usage} totals={usage.totals} />
    </section>
  );
}
