import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { AuthConfigError, DEV_JWT_SECRET, resolveJwtSecret } from "./tokens.js";

/** Mirrors vault.test.ts's `reasonOf`: a clean return is itself a failure. */
function throwsConfigError(fn: () => unknown): string {
  let returned: unknown;
  try {
    returned = fn();
  } catch (err) {
    if (err instanceof AuthConfigError) return err.message;
    throw err;
  }
  throw new Error(`expected an AuthConfigError, got: ${String(returned)}`);
}

describe("jwt secret resolution", () => {
  it("falls back to the dev secret outside production", () => {
    expect(resolveJwtSecret({})).toBe(DEV_JWT_SECRET);
    expect(resolveJwtSecret({ NODE_ENV: "test" })).toBe(DEV_JWT_SECRET);
    // An explicit secret outside production is used as-is, however short.
    expect(resolveJwtSecret({ JWT_SECRET: "short-dev-secret" })).toBe(
      "short-dev-secret",
    );
  });

  it("refuses to resolve a missing production secret", () => {
    expect(throwsConfigError(() => resolveJwtSecret({ NODE_ENV: "production" }))).toContain(
      "JWT_SECRET",
    );
    expect(
      throwsConfigError(() =>
        resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "" }),
      ),
    ).toContain("required");
    expect(
      throwsConfigError(() =>
        resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "   " }),
      ),
    ).toContain("required");
  });

  it("refuses a production secret under 32 characters", () => {
    expect(
      throwsConfigError(() =>
        resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "a".repeat(31) }),
      ),
    ).toContain("32");
    const ok = randomBytes(48).toString("base64");
    expect(resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: ok })).toBe(ok);
  });

  it("refuses a production secret containing the built-in dev value", () => {
    // Forgeable tokens are a master key for the vault: every AI route is
    // reachable with nothing but a bearer token.
    for (const raw of [
      DEV_JWT_SECRET,
      `${DEV_JWT_SECRET}!`,
      `  ${DEV_JWT_SECRET}\n`,
      DEV_JWT_SECRET.toUpperCase(),
      `prefix-${DEV_JWT_SECRET}-suffix`,
    ]) {
      expect(
        throwsConfigError(() =>
          resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: raw }),
        ),
      ).toContain("built-in development secret");
    }
  });

  it("applies the production checks on a deployed host with no NODE_ENV", () => {
    expect(throwsConfigError(() => resolveJwtSecret({ RENDER: "true" }))).toContain(
      "JWT_SECRET",
    );
    expect(
      throwsConfigError(() =>
        resolveJwtSecret({ K_SERVICE: "nomad", JWT_SECRET: DEV_JWT_SECRET }),
      ),
    ).toContain("built-in development secret");
    // Still the dev fallback on a laptop.
    expect(resolveJwtSecret({ CI: "true" })).toBe(DEV_JWT_SECRET);
  });
});
