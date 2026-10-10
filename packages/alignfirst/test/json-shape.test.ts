import { describe, expect, it } from "vitest";

import {
  boolean,
  type Check,
  integerBetween,
  literal,
  nonEmptyString,
  object,
  optional,
  parseShape,
  record,
  shapeError,
} from "../src/json-shape.js";

interface Sample {
  name: string;
  port?: number;
  nested?: { flag: boolean };
  map?: Record<string, { mode?: "a" | "b" }>;
}

const sampleShape = object<Sample>({
  name: nonEmptyString,
  port: optional(integerBetween(1, 65_535)),
  nested: optional(object<{ flag: boolean }>({ flag: boolean })),
  map: optional(record(object<{ mode?: "a" | "b" }>({ mode: optional(literal("a", "b")) }))),
});

describe("json shape", () => {
  it("returns the checked value without absent keys", () => {
    const value = { name: "x", port: 80, nested: { flag: true }, map: { "~/p": { mode: "a" } } };
    expect(parse(sampleShape, value)).toEqual(value);
    const result = parse(sampleShape, { name: "x" });
    expect(result).toEqual({ name: "x" });
    expect(Object.keys(result)).toEqual(["name"]);
  });

  it.each([
    [[], "value must be an object"],
    [null, "value must be an object"],
    ["text", "value must be an object"],
    [{ name: "x", extra: 1 }, "extra must be removed"],
    [{ name: "x", "a-b": 1 }, 'value["a-b"] must be removed'],
    [{ name: "x", nested: { flag: true, extra: 1 } }, "nested.extra must be removed"],
    [{ name: "x", map: { "~/p": { ".plans": true } } }, 'map["~/p"][".plans"] must be removed'],
    [{ name: "x", map: { "~/p": { mode: "c" } } }, 'map["~/p"].mode must be "a" or "b"'],
    [{ name: "x", map: [] }, "map must be an object"],
    [{}, "name must be a non-empty string"],
    [{ name: "" }, "name must be a non-empty string"],
    [{ name: "x", port: 0 }, "port must be an integer from 1 to 65535"],
    [{ name: "x", port: 1.5 }, "port must be an integer from 1 to 65535"],
    [{ name: "x", port: "80" }, "port must be an integer from 1 to 65535"],
    [{ name: "x", nested: {} }, "nested.flag must be a boolean"],
    [{ name: "x", nested: null }, "nested must be an object"],
  ])("rejects %j", (value, message) => {
    expect(() => parse(sampleShape, value)).toThrow(`invalid: ${message}`);
  });

  it("reports an unknown key before the fields, then the first field in declaration order", () => {
    expect(() => parse(sampleShape, { port: 0, extra: 1 })).toThrow("extra must be removed");
    expect(() => parse(sampleShape, { port: 0 })).toThrow("name must be a non-empty string");
  });

  it.each<[Check<unknown>, string]>([
    [literal(1), "value must be 1"],
    [literal("a", "b"), 'value must be "a" or "b"'],
    [literal("a", "b", "c"), 'value must be "a", "b" or "c"'],
  ])("words a literal expectation %#", (check, message) => {
    expect(() => parse(check, "z")).toThrow(`invalid: ${message}`);
  });

  it("wraps shapeError failures and lets other errors pass through", () => {
    const custom: Check<string> = (_value, path) => {
      throw shapeError(path, 'be a boolean or "auto"');
    };
    expect(() => parse(object<{ flag: string }>({ flag: custom }), { flag: 1 })).toThrow(
      'invalid: flag must be a boolean or "auto"',
    );
    const failing: Check<string> = () => {
      throw new Error("boom");
    };
    expect(() => parse(failing, 1)).toThrow(/^boom$/);
  });
});

function parse<T>(check: Check<T>, value: unknown): T {
  return parseShape(check, value, (detail) => new Error(`invalid: ${detail}`));
}
