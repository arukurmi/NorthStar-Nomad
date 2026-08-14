import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Only the failure case is spawned — a correctly configured production boot
// would listen forever. One spawn serves all three assertions.
let boot: SpawnSyncReturns<string>;
let dbDir: string;

beforeAll(() => {
  // A throwaway database path: NODE_ENV=production means db.ts opens a file,
  // and the repo's own data.sqlite must not be touched by a test.
  dbDir = mkdtempSync(path.join(tmpdir(), "nomad-boot-"));
  boot = spawnSync("npx", ["tsx", "src/index.ts"], {
    cwd: serverRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NOMAD_MASTER_KEY: "",
      NOMAD_DB: path.join(dbDir, "boot-test.sqlite"),
      PORT: "0",
    },
  });
}, 30_000);

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe("production boot guard", () => {
  it("exits non-zero when NODE_ENV=production and NOMAD_MASTER_KEY is unset", () => {
    expect(boot.error).toBeUndefined();
    expect(boot.signal).toBeNull();
    expect(boot.status).toBe(1);
  });

  it("prints a message naming NOMAD_MASTER_KEY on stderr", () => {
    expect(boot.stderr).toContain("NOMAD_MASTER_KEY");
    expect(boot.stderr).toContain("FATAL");
    // The operator is told how to fix it, not merely that it is broken.
    expect(boot.stderr).toContain("openssl rand -base64 48");
    expect(boot.stderr).toContain("Refusing to start.");
  });

  it("does not bind a port before exiting", () => {
    expect(boot.stdout).not.toContain("listening on");
  });
});
