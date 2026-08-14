import {
  AiError,
  PROVIDER_IDS,
  type AiProvider,
  type ProviderId,
} from "./provider.js";
import {
  createFakeProvider,
  type FakeProvider,
  type FakeScript,
} from "./providers/fake.js";

/**
 * The only place a route learns a concrete vendor exists. Routes import
 * `getProvider`, never an adapter, which is what makes "add a fourth provider
 * without touching a route" true.
 */
let providers = buildProviders();

/**
 * Placeholder for a vendor adapter that has not been written yet. Phases 6-8
 * replace these entries with the real Anthropic, Gemini and OpenAI adapters.
 * It fails when *called*, not at module init, so the registry stays total and
 * the fake path is unaffected.
 */
function pendingAdapter(id: ProviderId): AiProvider {
  const unavailable = () =>
    Promise.reject(
      new AiError("provider_error", `the ${id} adapter is not available yet`, {
        provider: id,
      }),
    );
  return {
    id,
    defaultModel: "",
    validate: unavailable,
    complete: unavailable,
  };
}

function buildProviders(): Record<ProviderId, AiProvider> {
  // src/test-setup.ts sets NOMAD_AI_FAKE, so the whole route suite is
  // network-free by construction rather than by remembering to stub.
  const fake = process.env.NOMAD_AI_FAKE === "1";
  const built = {} as Record<ProviderId, AiProvider>;
  for (const id of PROVIDER_IDS) {
    built[id] = fake ? createFakeProvider(id) : pendingAdapter(id);
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
