import { describe, expect, it } from "vitest";

import {
  detectCommonJsError,
  extractHost,
  formatDuration,
  lastLines,
  patchEnvFile,
} from "../src/helpers.js";

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

describe("detectCommonJsError", () => {
  it("matches nodemon crash", () => {
    expect(detectCommonJsError("foo\n[nodemon] app crashed - waiting\n")).toBe(
      "[nodemon] app crashed",
    );
  });

  it("matches Node.js footer at line start", () => {
    expect(detectCommonJsError("Error: bad\n    at x\nNode.js v24.11.1\n")).toBe("Node.js v");
  });

  it("does not match Node.js v inside another line", () => {
    expect(detectCommonJsError("Running on Node.js v24 (info)")).toBe(false);
  });

  it("matches Cannot find module", () => {
    expect(detectCommonJsError("Error: Cannot find module 'foo'")).toBe(
      "Error: Cannot find module",
    );
  });

  it("matches SyntaxError at line start", () => {
    expect(detectCommonJsError("...\nSyntaxError: Unexpected token\n")).toBe("SyntaxError");
  });

  it("matches UnhandledPromiseRejection", () => {
    expect(detectCommonJsError("UnhandledPromiseRejection: blah")).toBe(
      "UnhandledPromiseRejection",
    );
  });

  it("returns false on clean startup log", () => {
    expect(detectCommonJsError("Server ready on port 3000\n")).toBe(false);
  });
});

describe("lastLines", () => {
  it("returns all lines when fewer than count", () => {
    expect(lastLines("a\nb", 5)).toBe("a\nb");
  });

  it("keeps only the last count lines", () => {
    expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("preserves a trailing newline as an empty last line", () => {
    expect(lastLines("a\nb\n", 2)).toBe("b\n");
  });
});

describe("formatDuration", () => {
  it("returns 0s for zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("returns 0s for negative input", () => {
    expect(formatDuration(-123)).toBe("0s");
  });

  it("rounds sub-second up to 1s", () => {
    expect(formatDuration(999)).toBe("1s");
  });

  it("formats single seconds unit", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });

  it("formats minutes + seconds", () => {
    expect(formatDuration(252_000)).toBe("4m 12s");
  });

  it("formats hours + minutes", () => {
    expect(formatDuration(11_100_000)).toBe("3h 5m");
  });

  it("formats days + hours", () => {
    expect(formatDuration((2 * 86400 + 7 * 3600) * 1000)).toBe("2d 7h");
  });

  it("drops the zero smaller unit", () => {
    expect(formatDuration(5 * 86400 * 1000)).toBe("5d");
  });
});
