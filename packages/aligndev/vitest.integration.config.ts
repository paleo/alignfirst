import { defineConfig } from "vitest/config";
import { requireBuiltArtifacts, sharedCliArtifacts } from "../../scripts/test/built-artifacts.mjs";

requireBuiltArtifacts([...sharedCliArtifacts, "packages/aligndev/dist/cli.js"]);

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    fileParallelism: false,
  },
});
