import { describe, expect, it } from "vitest";
import { resolveParallel } from "../src/env-cli.js";

describe("resolveParallel", () => {
  it("defaults to 1 when neither flag nor env var is set", () => {
    expect(resolveParallel(undefined, undefined)).toBe(1);
  });

  it("reads the env var when the flag is absent", () => {
    expect(resolveParallel(undefined, "3")).toBe(3);
  });

  it("prefers the flag over the env var", () => {
    expect(resolveParallel("2", "5")).toBe(2);
  });

  it("rejects zero, naming the flag", () => {
    expect(() => resolveParallel("0", undefined)).toThrow(/--parallel/);
  });

  it("rejects negatives, naming the env var", () => {
    expect(() => resolveParallel(undefined, "-2")).toThrow(/OPENCLAW_TEST_PARALLEL/);
  });

  it("rejects non-integers", () => {
    expect(() => resolveParallel("1.5", undefined)).toThrow(/--parallel/);
  });

  it("rejects non-numeric values", () => {
    expect(() => resolveParallel(undefined, "many")).toThrow(/OPENCLAW_TEST_PARALLEL/);
  });
});
