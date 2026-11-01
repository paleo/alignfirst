import { defineConfig } from "vitest/config";
import { requireBuiltArtifacts, sharedCliArtifacts } from "../../scripts/test/built-artifacts.mjs";

requireBuiltArtifacts(sharedCliArtifacts);

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    fileParallelism: false,
  },
});
