import { describe, expect, it } from "vitest";

import { readDevLimit } from "../src/dev-limit.js";

const PROJECT = "MYAPP_DEV_LIMIT";

function call(env: Record<string, string | undefined>, defaultLimit?: number): number {
  return readDevLimit({ projectVar: PROJECT, defaultLimit, env: env as NodeJS.ProcessEnv });
}

describe("readDevLimit", () => {
  it("uses the project-specific var when set", () => {
    expect(call({ [PROJECT]: "3" })).toBe(3);
  });

  it("falls back to PROJECT_DEV_LIMIT when project var unset", () => {
    expect(call({ PROJECT_DEV_LIMIT: "7" })).toBe(7);
  });

  it("uses the project var over the cross-project default", () => {
    expect(call({ [PROJECT]: "2", PROJECT_DEV_LIMIT: "9" })).toBe(2);
  });

  it("falls back to default when neither set", () => {
    expect(call({})).toBe(5);
  });

  it("respects a custom default", () => {
    expect(call({}, 99)).toBe(99);
  });

  it("skips empty / non-numeric / negative values", () => {
    expect(call({ [PROJECT]: "", PROJECT_DEV_LIMIT: "8" })).toBe(8);
    expect(call({ [PROJECT]: "abc", PROJECT_DEV_LIMIT: "8" })).toBe(8);
    expect(call({ [PROJECT]: "-1", PROJECT_DEV_LIMIT: "8" })).toBe(8);
  });

  it("returns 0 (unlimited) when explicitly set", () => {
    expect(call({ [PROJECT]: "0" })).toBe(0);
  });
});
