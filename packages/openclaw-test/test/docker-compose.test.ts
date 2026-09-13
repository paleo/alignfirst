import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("gateway Compose service", () => {
  it("declares the externally managed runtime config read-only", () => {
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
    const gatewayStart = compose.indexOf("\n  gateway:");
    const gatewayEnd = compose.indexOf("\n  runner:");

    // Both markers must be found and ordered, otherwise the slice would silently widen to the
    // rest of the file and the assertion would accept the variable on any other service.
    expect(gatewayStart).toBeGreaterThan(-1);
    expect(gatewayEnd).toBeGreaterThan(gatewayStart);
    expect(compose.slice(gatewayStart, gatewayEnd)).toContain('OPENCLAW_CONFIG_READONLY: "1"');
  });
});
