import { describe, expect, it } from "vitest";

import {
  arrayOf,
  boolean,
  type Check,
  integerBetween,
  literal,
  matching,
  nonEmptyArrayOf,
  nonEmptyString,
  object,
  optional,
  parseShape,
  string,
} from "../src/json-shape.js";

interface Sample {
  agent: "claude" | "codex";
  root?: string;
  models?: string[];
  skip?: boolean;
  ranges?: SampleRange[];
}

interface SampleRange {
  first: number;
  code?: string;
  description?: string;
}

const sampleShape = object<Sample>({
  agent: literal("claude", "codex"),
  root: optional(nonEmptyString),
  models: optional(arrayOf(string)),
  skip: optional(boolean),
  ranges: optional(
    nonEmptyArrayOf(
      object<SampleRange>({
        first: integerBetween(1, 65_535),
        code: optional(matching(/^[a-z][a-z0-9-]*$/)),
        description: optional(string),
      }),
    ),
  ),
});

describe("json shape", () => {
  it("returns the checked value without absent keys", () => {
    const value = {
      agent: "codex",
      root: "~/p",
      models: ["a"],
      skip: false,
      ranges: [{ first: 80, code: "web", description: "" }, { first: 90 }],
    };
    expect(parse(sampleShape, value)).toEqual(value);
    const result = parse(sampleShape, { agent: "claude" });
    expect(result).toEqual({ agent: "claude" });
    expect(Object.keys(result)).toEqual(["agent"]);
  });

  it.each([
    [[], "value must be an object"],
    [null, "value must be an object"],
    [{ agent: "claude", extra: 1 }, "extra must be removed"],
    [{ agent: "claude", "a-b": 1 }, 'value["a-b"] must be removed'],
    [{ agent: "claude", ranges: [{ first: 80, extra: 1 }] }, "ranges[0].extra must be removed"],
    [{}, 'agent must be "claude" or "codex"'],
    [{ agent: "gemini" }, 'agent must be "claude" or "codex"'],
    [{ agent: "claude", root: "" }, "root must be a non-empty string"],
    [{ agent: "claude", models: "a" }, "models must be an array"],
    [{ agent: "claude", models: ["a", 1] }, "models[1] must be a string"],
    [{ agent: "claude", skip: "no" }, "skip must be a boolean"],
    [{ agent: "claude", ranges: [] }, "ranges must be a non-empty array"],
    [{ agent: "claude", ranges: {} }, "ranges must be an array"],
    [
      { agent: "claude", ranges: [{ first: 0 }] },
      "ranges[0].first must be an integer from 1 to 65535",
    ],
    [
      { agent: "claude", ranges: [{ first: 80 }, { first: 90, code: "Web" }] },
      "ranges[1].code must match /^[a-z][a-z0-9-]*$/",
    ],
    [{ agent: "claude", ranges: [{ first: 80, code: 1 }] }, "ranges[0].code must be a string"],
    [
      { agent: "claude", ranges: [{ first: 80, description: 1 }] },
      "ranges[0].description must be a string",
    ],
  ])("rejects %j", (value, message) => {
    expect(() => parse(sampleShape, value)).toThrow(`invalid: ${message}`);
  });

  it("reports an unknown key before the fields, then the first field in declaration order", () => {
    expect(() => parse(sampleShape, { root: "", extra: 1 })).toThrow("extra must be removed");
    expect(() => parse(sampleShape, { root: "" })).toThrow('agent must be "claude" or "codex"');
  });

  it.each<[Check<unknown>, string]>([
    [literal(1), "value must be 1"],
    [literal("a", "b", "c"), 'value must be "a", "b" or "c"'],
    [arrayOf(string), "value must be an array"],
  ])("words a root expectation %#", (check, message) => {
    expect(() => parse(check, "z")).toThrow(`invalid: ${message}`);
  });

  it("puts array indexes on the root path", () => {
    expect(() => parse(arrayOf(string), [1])).toThrow("invalid: value[0] must be a string");
  });

  it("lets non-shape errors pass through", () => {
    const failing: Check<string> = () => {
      throw new Error("boom");
    };
    expect(() => parse(failing, 1)).toThrow(/^boom$/);
  });
});

function parse<T>(check: Check<T>, value: unknown): T {
  return parseShape(check, value, (detail) => new Error(`invalid: ${detail}`));
}
