import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** A master key that passes every check, so a boot can fail for one reason. */
const GOOD_MASTER_KEY = randomBytes(48).toString("base64");
const GOOD_JWT_SECRET = randomBytes(48).toString("base64");

// Only failure cases are spawned — a correctly configured production boot would
// listen forever.
let dbDir: string;

function bootWith(env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync("npx", ["tsx", "src/index.ts"], {
    cwd: serverRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      // A throwaway database path: NODE_ENV=production means db.ts opens a
      // file, and the repo's own data.sqlite must not be touched by a test.
      NOMAD_DB: path.join(dbDir, "boot-test.sqlite"),
      PORT: "0",
      ...env,
    },
  });
}

let missingMasterKey: SpawnSyncReturns<string>;
let missingJwtSecret: SpawnSyncReturns<string>;
let devJwtSecret: SpawnSyncReturns<string>;

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), "nomad-boot-"));
  missingMasterKey = bootWith({ NOMAD_MASTER_KEY: "", JWT_SECRET: GOOD_JWT_SECRET });
  missingJwtSecret = bootWith({ NOMAD_MASTER_KEY: GOOD_MASTER_KEY, JWT_SECRET: "" });
  devJwtSecret = bootWith({
    NOMAD_MASTER_KEY: GOOD_MASTER_KEY,
    JWT_SECRET: "northstar-dev-secret-change-in-production",
  });
}, 60_000);

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe("production boot guard", () => {
  it("exits non-zero when NODE_ENV=production and NOMAD_MASTER_KEY is unset", () => {
    expect(missingMasterKey.error).toBeUndefined();
    expect(missingMasterKey.signal).toBeNull();
    expect(missingMasterKey.status).toBe(1);
  });

  it("prints a message naming NOMAD_MASTER_KEY on stderr", () => {
    expect(missingMasterKey.stderr).toContain("NOMAD_MASTER_KEY");
    expect(missingMasterKey.stderr).toContain("FATAL");
    // The operator is told how to fix it, not merely that it is broken.
    expect(missingMasterKey.stderr).toContain("openssl rand -base64 48");
    expect(missingMasterKey.stderr).toContain("Refusing to start.");
  });

  it("does not bind a port before exiting", () => {
    expect(missingMasterKey.stdout).not.toContain("listening on");
  });
});

describe("production jwt secret guard", () => {
  it("refuses to start when JWT_SECRET is unset", () => {
    // Without this the process would sign sessions with a constant published in
    // this repository — anyone could mint a token for any account and read that
    // account's AI keys, which defeats the vault entirely.
    expect(missingJwtSecret.error).toBeUndefined();
    expect(missingJwtSecret.signal).toBeNull();
    expect(missingJwtSecret.status).toBe(1);
    expect(missingJwtSecret.stderr).toContain("JWT_SECRET");
    expect(missingJwtSecret.stderr).toContain("FATAL");
    expect(missingJwtSecret.stderr).toContain("openssl rand -base64 48");
    expect(missingJwtSecret.stdout).not.toContain("listening on");
  });

  it("refuses to start with the built-in dev JWT secret in production", () => {
    expect(devJwtSecret.status).toBe(1);
    expect(devJwtSecret.stderr).toContain("built-in development secret");
    expect(devJwtSecret.stdout).not.toContain("listening on");
  });
});
