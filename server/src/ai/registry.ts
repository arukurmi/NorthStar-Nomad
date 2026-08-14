import { PROVIDER_IDS, type AiProvider, type ProviderId } from "./provider.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import {
  createFakeProvider,
  type FakeProvider,
  type FakeScript,
} from "./providers/fake.js";
import { createGeminiProvider } from "./providers/gemini.js";
import { createOpenAiProvider } from "./providers/openai.js";

/**
 * The only place a route learns a concrete vendor exists. Routes import
 * `getProvider`, never an adapter, which is what makes "add a fourth provider
 * without touching a route" true.
 */
let providers = buildProviders();

/**
 * The real vendor adapter for an id. The switch is exhaustive over ProviderId
 * with no default, so adding a fourth provider is a compile error here — which
 * is the one place it should be.
 */
function realAdapter(id: ProviderId): AiProvider {
  switch (id) {
    case "anthropic":
      return createAnthropicProvider();
    case "gemini":
      return createGeminiProvider();
    case "openai":
      return createOpenAiProvider();
  }
}

function buildProviders(): Record<ProviderId, AiProvider> {
  // src/test-setup.ts sets NOMAD_AI_FAKE, so the whole route suite is
  // network-free by construction rather than by remembering to stub.
  const fake = process.env.NOMAD_AI_FAKE === "1";
  const built = {} as Record<ProviderId, AiProvider>;
  for (const id of PROVIDER_IDS) {
    built[id] = fake ? createFakeProvider(id) : realAdapter(id);
  }
  return built;
}

export function getProvider(id: ProviderId): AiProvider {
  return providers[id];
}

/** Swaps in freshly scripted fakes and hands the test a handle on them. */
export function useFakeProviders(
  script?: FakeScript,
): Record<ProviderId, FakeProvider> {
  const fakes = {} as Record<ProviderId, FakeProvider>;
  for (const id of PROVIDER_IDS) fakes[id] = createFakeProvider(id, script);
  providers = { ...fakes };
  return fakes;
}

/** Restores the env-derived registry. Belongs in an `afterEach`. */
export function resetProviders(): void {
  providers = buildProviders();
}
