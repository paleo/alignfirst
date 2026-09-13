import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("gateway Compose service", () => {
  it("declares the externally managed runtime config read-only", () => {
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
    const gateway = compose.slice(compose.indexOf("  gateway:"), compose.indexOf("  runner:"));

    expect(gateway).toContain('OPENCLAW_CONFIG_READONLY: "1"');
  });
});
