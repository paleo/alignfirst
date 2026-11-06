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
  nonblankString,
  nulFreeString,
  object,
  optional,
  parseShape,
  record,
  string,
} from "../src/json-shape.js";

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
    expect(parse(sampleShape, { agent: "claude" })).toEqual({ agent: "claude" });
  });

  it.each(
    [
      [],
      null,
      { agent: "claude", extra: 1 },
      { agent: "claude", ranges: [{ first: 80, extra: 1 }] },
      {},
      { agent: "gemini" },
      { agent: "claude", root: "" },
      { agent: "claude", models: "a" },
      { agent: "claude", models: ["a", 1] },
      { agent: "claude", skip: "no" },
      { agent: "claude", ranges: [] },
      { agent: "claude", ranges: {} },
      { agent: "claude", ranges: [{ first: 0 }] },
      { agent: "claude", ranges: [{ first: 80 }, { first: 90, code: "Web" }] },
      { agent: "claude", ranges: [{ first: 80, code: 1 }] },
    ].map((value) => [value]),
  )("rejects invalid shape %j", (value) => {
    expect(() => parse(sampleShape, value)).toThrow(TypeError);
  });

  it("opts into unknown-key handling without retaining or traversing unknown values", () => {
    const warnings: string[] = [];
    const tolerant = object<{ enabled: boolean }>({ enabled: boolean }, (path, key) =>
      warnings.push(`${path}.${key}`),
    );
    const value = { enabled: false, old: { broken: true }, other: null };
    expect(parse(tolerant, value)).toEqual({ enabled: false });
    expect(warnings).toEqual([".old", ".other"]);
    expect(value.old).toEqual({ broken: true });
    expect(() => parse(tolerant, { enabled: "yes", stale: true })).toThrow(TypeError);
  });

  it("redacts dynamic record keys in warning paths", () => {
    const warnings: string[] = [];
    const shape = record(
      object<{ enabled: boolean }>({ enabled: boolean }, (path, key) =>
        warnings.push(`${path}.${key}`),
      ),
    );
    expect(parse(shape, { "sk-sensitive\nname": { enabled: true, stale: 1 } })).toEqual({
      "sk-sensitive\nname": { enabled: true },
    });
    expect(warnings).toEqual(["[<entry>].stale"]);
  });

  it("validates arbitrary record keys and values without prototype lookup", () => {
    const value = JSON.parse('{"__proto__":"native","constructor":"other"}');
    const checked = parse(record(nonblankString, nonblankString), value);
    expect(Object.hasOwn(checked, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(checked, "__proto__")?.value).toBe("native");
    expect(checked.constructor).toBe("other");
    expect(() => parse(record(string), [])).toThrow(TypeError);
    expect(() => parse(record(nonblankString), { target: " " })).toThrow(TypeError);
    expect(() => parse(record(string, nonblankString), { " ": "target" })).toThrow(TypeError);
    expect(() => parse(nulFreeString, "a\0b")).toThrow(TypeError);
  });

  it("lets non-shape errors pass through", () => {
    const failure = new Error("boom");
    const failing: Check<string> = () => {
      throw failure;
    };
    try {
      parse(failing, 1);
      expect.fail("Expected the supplied error");
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
});

function parse<T>(check: Check<T>, value: unknown): T {
  return parseShape(check, value, (detail) => new TypeError(detail));
}
