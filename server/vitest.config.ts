import { defineConfig } from "vitest/config";

// The defaults are otherwise fine — this exists solely to register the setup
// file that makes network access from a test impossible.
export default defineConfig({
  test: {
    setupFiles: ["src/test-setup.ts"],
  },
});
