import { describe, expect, it } from "vitest";

import { extractHost, patchEnvFile } from "../src/helpers.js";

describe("patchEnvFile", () => {
  it("replaces an existing line in place", () => {
    const before = "PORT=3000\nNAME=app\n";
    expect(patchEnvFile(before, { PORT: "8100" })).toBe("PORT=8100\nNAME=app\n");
  });

  it("appends when key missing", () => {
    const before = "NAME=app\n";
    expect(patchEnvFile(before, { PORT: "8100" })).toBe("NAME=app\nPORT=8100\n");
  });

  it("ends with a single trailing newline", () => {
    expect(patchEnvFile("KEY=v\n\n\n", { KEY: "x" })).toBe("KEY=x\n");
  });

  it("handles multiple patches at once", () => {
    const out = patchEnvFile("A=1\nB=2\n", { A: "10", C: "30" });
    expect(out).toBe("A=10\nB=2\nC=30\n");
  });
});

describe("extractHost", () => {
  it("falls back to localhost when key absent", () => {
    expect(extractHost("OTHER=x\n", "API_URL")).toBe("localhost");
  });

  it("extracts an IPv4 host", () => {
    expect(extractHost("API_URL=http://1.2.3.4:8001\n", "API_URL")).toBe("1.2.3.4");
  });

  it("extracts a hostname", () => {
    expect(extractHost("API_URL=https://example.com:443\n", "API_URL")).toBe("example.com");
  });

  it("works without a scheme", () => {
    expect(extractHost("HOST=myhost:1000\n", "HOST")).toBe("myhost");
  });

  it("uses custom fallback", () => {
    expect(extractHost("", "API_URL", "fallback.example")).toBe("fallback.example");
  });
});
