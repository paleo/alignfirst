import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readProjectConfig, validateProjectConfig } from "../src/project-config.js";
import { makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project config", () => {
  it("accepts the full shape and a minimal config", () => {
    const full = {
      schemaVersion: 1,
      cli: ">=0.1.0 <0.2.0",
      ticketPattern: "^\\d+$",
      plans: { folder: "project" },
      portRange: { first: 8100, last: 8199 },
      project: { remote: "github.com/org/repo", paths: ["/project"] },
    };
    expect(validateProjectConfig(full, "config")).toEqual(full);
    expect(validateProjectConfig({ schemaVersion: 1 }, "config")).toEqual({ schemaVersion: 1 });
  });

  it.each([
    [{ schemaVersion: 1, extra: true }, "extra"],
    [{ schemaVersion: 1, cli: "not a range" }, "semver"],
    [{ schemaVersion: 1, ticketPattern: "[" }, "regular expression"],
    [{ schemaVersion: 1, portRange: { first: 2, last: 1 } }, "must not exceed"],
    [{ schemaVersion: 1, project: {} }, "remote or paths"],
    [{ schemaVersion: 1, project: { paths: ["relative"] } }, "absolute paths"],
  ])("rejects invalid config %#", (value, message) => {
    expect(() => validateProjectConfig(value, "config")).toThrow(message);
  });

  it("reads a file, returns undefined when absent, and reports invalid JSON", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    expect(readProjectConfig(dir)).toBeUndefined();
    writeFileSync(join(dir, ".alignfirst.json"), '{"schemaVersion":1}');
    expect(readProjectConfig(dir)).toEqual({ schemaVersion: 1 });
    writeFileSync(join(dir, ".alignfirst.json"), "{");
    expect(() => readProjectConfig(dir)).toThrow(`Invalid ${join(dir, ".alignfirst.json")}`);
  });

  it("rejects a directory in place of the config file", () => {
    const dir = makeTempDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".alignfirst.json"));
    expect(() => readProjectConfig(dir)).toThrow("Invalid");
  });
});
