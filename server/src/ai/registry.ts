import { PROVIDER_IDS, type AiProvider, type ProviderId } from "./provider.js";
import { looksDeployed } from "./vault.js";
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

const FAKE_IN_PROD = [
  "FATAL: NOMAD_AI_FAKE=1 outside an explicit test or development process.",
  "That replaces every AI provider with a stub: any string is accepted as a",
  "valid API key, and fabricated answers are written to the shared ai_cache and",
  "served to every user for the next 30 days.",
  "Unset it, or set NODE_ENV=development if this really is a dev machine.",
].join("\n");

/**
 * The same bar `assertVaultConfigured` and `assertAuthConfigured` already set,
 * applied to the one remaining env var that can silently hollow out the feature.
 *
 * It did not matter in F0, because nothing called `complete()` — a fake
 * provider had nothing to fake. F2 is the first feature whose output the fakes
 * would author, and that output is cached globally, so a stray env var stops
 * being a development convenience and becomes fabricated content served to
 * strangers under our UI's trust.
 */
export function assertProvidersConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NOMAD_AI_FAKE !== "1") return;
  // Fails **closed**: the fakes are allowed only where NODE_ENV explicitly says
  // test or development. The first version of this asked "does this look
  // deployed?" and allowed anything it did not recognise — but `looksDeployed`
  // knows a fixed list of platform markers, so a bare VM, a plain Docker image
  // or an EC2 box with neither NODE_ENV nor a marker would have run the fakes
  // silently. Given the blast radius — any string accepted as an API key, and
  // fabricated lists written into the global cache and served to strangers for
  // thirty days — an unrecognised host must refuse rather than proceed.
  const allowed = env.NODE_ENV === "test" || env.NODE_ENV === "development";
  if (allowed && !looksDeployed(env)) return;
  process.stderr.write(`${FAKE_IN_PROD}\n`);
  process.exit(1);
}
