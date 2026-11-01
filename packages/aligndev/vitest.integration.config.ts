import { defineConfig } from "vitest/config";
import { requireBuiltArtifacts, sharedCliArtifacts } from "../../scripts/test/built-artifacts.mjs";

requireBuiltArtifacts([
  ...sharedCliArtifacts,
  "packages/aligndev/dist/cli.js",
  ...["claude-agent", "machine-id", "models", "quota-process", "run-agent", "session-file"].map(
    (name) => `packages/aligndev/dist/code/${name}.js`,
  ),
]);

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    fileParallelism: false,
  },
});
