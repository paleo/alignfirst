import { describe, expect, it } from "vitest";
import { buildConsumerImageArgs, resolveParallel } from "../src/env-cli.js";

describe("buildConsumerImageArgs", () => {
  it("builds one service for the shared consumer image", () => {
    expect(buildConsumerImageArgs(["compose", "-p", "worker-1"])).toEqual([
      "compose",
      "-p",
      "worker-1",
      "build",
      "bus",
    ]);
  });
});

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

  it("rejects zero parallel workers", () => {
    expect(() => resolveParallel("0", undefined)).toThrow();
  });

  it("rejects negative worker counts from the environment", () => {
    expect(() => resolveParallel(undefined, "-2")).toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => resolveParallel("1.5", undefined)).toThrow();
  });

  it("rejects non-numeric values", () => {
    expect(() => resolveParallel(undefined, "many")).toThrow();
  });
});
