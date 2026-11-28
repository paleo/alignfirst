import { describe, expect, it } from "vitest";
import { resolveParallel } from "../src/env-cli.js";

describe("resolveParallel", () => {
  it.each([
    { flag: undefined, envValue: undefined, expected: 1 },
    { flag: undefined, envValue: "3", expected: 3 },
    { flag: "2", envValue: "5", expected: 2 },
  ])("resolves flag $flag and env $envValue to $expected", ({ flag, envValue, expected }) => {
    expect(resolveParallel(flag, envValue)).toBe(expected);
  });

  it.each([
    { flag: "0", envValue: undefined },
    { flag: undefined, envValue: "-2" },
    { flag: "1.5", envValue: undefined },
    { flag: undefined, envValue: "many" },
  ])("rejects flag $flag and env $envValue", ({ flag, envValue }) => {
    expect(() => resolveParallel(flag, envValue)).toThrow();
  });
});
