import { describe, expect, it } from "vitest";

import { isAheadOfRange, isValidVersionRange, satisfiesRange } from "../src/version-range.js";

describe("version range", () => {
  it.each([
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.2.3", "=1.2.3", true],
    ["1.2.4", "=1.2.3", false],
    ["1.2.4", ">1.2.3", true],
    ["1.2.3", ">1.2.3", false],
    ["1.2.3", ">=1.2.3", true],
    ["1.2.2", ">=1.2.3", false],
    ["1.2.2", "<1.2.3", true],
    ["1.2.3", "<1.2.3", false],
    ["1.2.3", "<=1.2.3", true],
    ["1.3.0", "<=1.2.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.2.2", "~1.2.3", false],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "^1.2.3", true],
    ["1.2.2", "^1.2.3", false],
    ["2.0.0", "^1.2.3", false],
    ["0.9.5", "^0.9.0", true],
    ["0.10.0", "^0.9.0", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["0.1.5", ">=0.1.0 <0.2.0", true],
    ["0.2.0", ">=0.1.0 <0.2.0", false],
    ["0.1.0", "  >=0.1.0\t<0.2.0  ", true],
    ["2.1.0", "^1.0.0 || ^2.0.0", true],
    ["3.0.0", "^1.0.0 || ^2.0.0", false],
  ])("checks %s against %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it.each([
    "0.x",
    "^0.9",
    "1.0.0 - 2.0.0",
    "^1.0.0-beta.1",
    "1.0.0+build",
    "v1.0.0",
    ">= 1.0.0",
    "01.0.0",
    "",
    "   ",
    "1.0.0 ||",
    "|| 1.0.0",
    "*",
  ])("rejects the range %j", (range) => {
    expect(isValidVersionRange(range)).toBe(false);
    expect(satisfiesRange("1.0.0", range)).toBe(false);
  });

  it("accepts every supported operator", () => {
    expect(isValidVersionRange("1.0.0 =1.0.0 >0.1.0 >=0.1.0 <2.0.0 <=2.0.0 ~1.0.0 ^1.0.0")).toBe(
      true,
    );
  });

  it("never satisfies with a prerelease or invalid installed version", () => {
    expect(satisfiesRange("0.9.1-next.0", "^0.9.0")).toBe(false);
    expect(satisfiesRange("0.9.1-next.0", ">=0.0.0")).toBe(false);
    expect(satisfiesRange("v0.9.1", "^0.9.0")).toBe(false);
  });

  it.each([
    ["1.0.0", "^0.9.0", true],
    ["0.10.0", "^0.9.0", true],
    ["0.9.5", "^0.9.0", false],
    ["0.8.0", "^0.9.0", false],
    ["5.0.0", ">=0.9.0", false],
    ["1.2.4", "1.2.3", true],
    ["1.2.4", "<=1.2.4", false],
    ["1.2.5", "<=1.2.4", true],
    ["3.0.0", "^1.0.0 || ^2.0.0", true],
    ["2.0.0", "^1.0.0 || ^2.0.0", false],
    ["3.0.0", "^1.0.0 || >=2.0.0", false],
    ["1.0.0-next.0", "^0.9.0", false],
    ["1.0.0", "not a range", false],
  ])("checks whether %s is ahead of %s", (version, range, expected) => {
    expect(isAheadOfRange(version, range)).toBe(expected);
  });
});
