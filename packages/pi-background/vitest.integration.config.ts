import { defineConfig } from "vitest/config";
import { requireBuiltArtifacts, sharedCliArtifacts } from "../../scripts/test/built-artifacts.mjs";

requireBuiltArtifacts([
  ...sharedCliArtifacts,
  "packages/aligndev/dist/cli.js",
  "packages/pi-background/dist/index.js",
  "packages/pi-background/index.js",
  "packages/pi-background/package.json",
]);

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
  },
});
