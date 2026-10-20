import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
  },
});
