import { describe, it, expect, vi, afterEach } from "vitest";
import { assertProvidersConfigured } from "./registry.js";

/**
 * `assertProvidersConfigured` is driven directly with a fake env rather than
 * through a spawned boot, for the same reason `resolveMasterKey` is: the
 * decision is a pure function of the environment, and a subprocess would only
 * add fifteen seconds and a timeout to the same assertion.
 */
function guard(env: Record<string, string | undefined>): {
  exited: boolean;
  stderr: string;
} {
  let exited = false;
  let stderr = "";
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(((): never => {
      exited = true;
      // Real process.exit never returns; the guard has nothing after it, so
      // returning is safe here and keeps the test out of a throw/catch dance.
      return undefined as never;
    }) as never);
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });

  assertProvidersConfigured(env as NodeJS.ProcessEnv);
  exit.mockRestore();
  write.mockRestore();
  return { exited, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertProvidersConfigured", () => {
  it("refuses to boot with the test fakes on a production host", () => {
    // A deployed process running the fakes accepts any string as an API key and
    // writes fabricated packing lists into the shared ai_cache, where they are
    // served to every other user for thirty days. It did not matter in F0
    // because nothing called complete(); F2 is the first feature whose output
    // the fakes would author.
    const { exited, stderr } = guard({
      NODE_ENV: "production",
      NOMAD_AI_FAKE: "1",
    });
    expect(exited).toBe(true);
    expect(stderr).toMatch(/NOMAD_AI_FAKE/);
  });

  it("refuses on a platform-marked host even without NODE_ENV=production", () => {
    // Matches the vault's rule: a host carrying a platform marker is deployed
    // whatever NODE_ENV happens to say.
    for (const marker of ["RENDER", "K_SERVICE", "DYNO"]) {
      const { exited } = guard({ NOMAD_AI_FAKE: "1", [marker]: "1" });
      expect(exited, `${marker} should refuse the fakes`).toBe(true);
    }
  });

  it("allows the fakes only where NODE_ENV says test or development", () => {
    expect(guard({ NODE_ENV: "test", NOMAD_AI_FAKE: "1" }).exited).toBe(false);
    expect(
      guard({ NODE_ENV: "development", NOMAD_AI_FAKE: "1" }).exited,
    ).toBe(false);
  });

  it("fails closed on a host it does not recognise", () => {
    // The important case, and the one the first version got wrong. A bare VM,
    // a plain Docker image or an EC2 box carries neither NODE_ENV nor a
    // platform marker — asking "does this look deployed?" let all of them run
    // the fakes. Given the blast radius, an unrecognised host must refuse.
    expect(guard({ NOMAD_AI_FAKE: "1" }).exited).toBe(true);
    expect(guard({ NODE_ENV: "staging", NOMAD_AI_FAKE: "1" }).exited).toBe(true);
    expect(guard({ NODE_ENV: "", NOMAD_AI_FAKE: "1" }).exited).toBe(true);
  });

  it("still refuses a marked host even when NODE_ENV says development", () => {
    // Someone who sets NODE_ENV=development on Render is not thereby making it
    // a development machine.
    expect(
      guard({ NODE_ENV: "development", NOMAD_AI_FAKE: "1", RENDER: "1" }).exited,
    ).toBe(true);
  });

  it("says nothing when the flag is unset or not exactly 1", () => {
    expect(guard({ NODE_ENV: "production" }).exited).toBe(false);
    expect(
      guard({ NODE_ENV: "production", NOMAD_AI_FAKE: "true" }).exited,
    ).toBe(false);
    expect(guard({ NODE_ENV: "production", NOMAD_AI_FAKE: "0" }).exited).toBe(
      false,
    );
  });
});
