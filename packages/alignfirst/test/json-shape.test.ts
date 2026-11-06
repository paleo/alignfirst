import { describe, expect, it, vi } from "vitest";

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
    [],
    null,
    "text",
    { name: "x", extra: 1 },
    { name: "x", "a-b": 1 },
    { name: "x", nested: { flag: true, extra: 1 } },
    { name: "x", map: { "~/p": { ".plans": true } } },
    { name: "x", map: { "~/p": { mode: "c" } } },
    { name: "x", map: [] },
    {},
    { name: "" },
    { name: "x", port: 0 },
    { name: "x", port: 1.5 },
    { name: "x", port: "80" },
    { name: "x", nested: {} },
    { name: "x", nested: null },
  ])("rejects %j", (value) => {
    expect(() => parse(sampleShape, value)).toThrow();
  });

  it("strips unknown fields with an optional callback and redacts record keys in warnings", () => {
    const warn = vi.fn();
    const check = object<{ map: Record<string, { flag: boolean }> }>(
      { map: record(object<{ flag: boolean }>({ flag: boolean }, warn)) },
      warn,
    );
    expect(
      parse(check, { extra: "PRIVATE", map: { "PRIVATE-PATH": { flag: true, other: null } } }),
    ).toEqual({ map: { "PRIVATE-PATH": { flag: true } } });
    expect(warn.mock.calls).toEqual([
      ["", "extra"],
      ["map[<entry>]", "other"],
    ]);
    expect(() => parse(check, { map: { "/p": { flag: "PRIVATE", extra: true } } })).toThrow();
  });

  it("lets errors from custom validators pass through", () => {
    const failure = new Error("boom");
    const failing: Check<string> = () => {
      throw failure;
    };
    expect(() => parse(failing, 1)).toThrow(failure);
  });
});

function parse<T>(check: Check<T>, value: unknown): T {
  return parseShape(check, value, (detail) => new Error(`invalid: ${detail}`));
}
