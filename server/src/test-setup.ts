/**
 * Two independent layers of network isolation, registered by vitest.config.ts
 * before any test file loads:
 *
 * 1. The registry hands back fake providers for all three ids.
 * 2. `fetch` throws.
 *
 * Either alone would be enough today. Together they mean that if someone later
 * imports a real adapter directly, the suite fails loudly instead of quietly
 * calling a vendor and burning a real user's key.
 */
process.env.NOMAD_AI_FAKE = "1";

globalThis.fetch = (() => {
  throw new Error("network access is not allowed in tests");
}) as typeof fetch;
