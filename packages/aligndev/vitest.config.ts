import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: ["test/e2e/**", "test/openclaw/**", "node_modules/**", "dist/**"] },
});
