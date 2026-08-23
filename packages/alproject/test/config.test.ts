import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_FILENAME, readConfig, readConfigIfPresent } from "../src/config.js";
import type { AlprojectError } from "../src/errors.js";
import {
  canonicalizeParentPaths,
  canonicalizePath,
  expandHomePath,
  normalizeAbsolutePath,
} from "../src/paths.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("path resolution", () => {
  it("expands only a leading home segment", () => {
    expect(expandHomePath("~/projects", "/home/tester")).toBe("/home/tester/projects");
    expect(expandHomePath("~other/projects", "/home/tester")).toBe("~other/projects");
  });

  it("requires absolute paths and normalizes them lexically", () => {
    expect(normalizeAbsolutePath("/srv/../projects", "/home/tester")).toBe("/projects");
    expect(() => normalizeAbsolutePath("projects", "/home/tester")).toThrow("must be absolute");
  });

  it("canonicalizes existing paths and preserves a normalized missing path", () => {
    const fixture = makeFixture();
    const real = join(fixture.home, "real");
    const link = join(fixture.home, "link");
    mkdirSync(real);
    symlinkSync(real, link);

    expect(canonicalizePath(link)).toBe(realpathSync(real));
    expect(canonicalizePath(join(fixture.home, "missing", "..", "gone"))).toBe(
      join(fixture.home, "gone"),
    );
  });

  it("deduplicates canonical parent paths", () => {
    const fixture = makeFixture();
    const real = join(fixture.home, "real");
    const link = join(fixture.home, "link");
    mkdirSync(real);
    symlinkSync(real, link);

    expect(canonicalizeParentPaths([real, link, real], fixture.home)).toEqual([realpathSync(real)]);
  });
});

describe("readConfig", () => {
  it("loads an omitted projectParents field as the canonical root", () => {
    const fixture = makeFixture();
    writeConfig(fixture, { firstPort: 8000, lastPort: 9999, root: "~/root" });

    expect(readConfig(fixture.home)).toEqual({
      configPath: join(fixture.home, CONFIG_FILENAME),
      firstPort: 8000,
      lastPort: 9999,
      projectParents: [realpathSync(fixture.root)],
      root: realpathSync(fixture.root),
    });
  });

  it("uses explicit project parents without adding root", () => {
    const fixture = makeFixture();
    const otherParent = join(fixture.home, "other");
    mkdirSync(otherParent);
    writeConfig(fixture, {
      firstPort: 1,
      lastPort: 65535,
      projectParents: ["~/other"],
      root: "~/root",
    });

    const config = readConfig(fixture.home);
    expect(config.projectParents).toEqual([realpathSync(otherParent)]);
    expect(config.projectParents).not.toContain(config.root);
  });

  it("canonicalizes and deduplicates explicit parents", () => {
    const fixture = makeFixture();
    const linkedRoot = join(fixture.home, "linked-root");
    symlinkSync(fixture.root, linkedRoot);
    writeConfig(fixture, {
      firstPort: 8000,
      lastPort: 9000,
      projectParents: ["~/root", "~/linked-root", "~/root/../root"],
      root: "~/linked-root",
    });

    const config = readConfig(fixture.home);
    expect(config.root).toBe(realpathSync(fixture.root));
    expect(config.projectParents).toEqual([realpathSync(fixture.root)]);
  });

  it("reports a missing configuration with its path", () => {
    const fixture = makeFixture();
    expect(() => readConfig(fixture.home)).toThrowError(
      expect.objectContaining<Partial<AlprojectError>>({
        code: "configuration",
        message: expect.stringContaining(join(fixture.home, CONFIG_FILENAME)),
      }),
    );
  });

  it("rejects malformed JSON with its configuration path", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, CONFIG_FILENAME), "{");
    expect(() => readConfig(fixture.home)).toThrow(/Invalid JSON.*\.alproject\.json/);
  });

  it.each([
    ["missing root", { firstPort: 8000, lastPort: 9000 }],
    ["missing first port", { lastPort: 9000, root: "~/root" }],
    ["missing last port", { firstPort: 8000, root: "~/root" }],
    ["unknown field", { extra: true, firstPort: 8000, lastPort: 9000, root: "~/root" }],
    ["empty root", { firstPort: 8000, lastPort: 9000, root: "" }],
    ["non-string root", { firstPort: 8000, lastPort: 9000, root: 42 }],
    ["empty parents", { firstPort: 8000, lastPort: 9000, projectParents: [], root: "~/root" }],
    ["empty parent", { firstPort: 8000, lastPort: 9000, projectParents: [""], root: "~/root" }],
    [
      "non-array parents",
      { firstPort: 8000, lastPort: 9000, projectParents: "~/root", root: "~/root" },
    ],
    ["non-number first port", { firstPort: "8000", lastPort: 9000, root: "~/root" }],
    ["non-integer first port", { firstPort: 8000.5, lastPort: 9000, root: "~/root" }],
    ["first port below range", { firstPort: 0, lastPort: 9000, root: "~/root" }],
    ["non-integer last port", { firstPort: 8000, lastPort: 9000.5, root: "~/root" }],
    ["last port above range", { firstPort: 8000, lastPort: 65536, root: "~/root" }],
    ["reversed ports", { firstPort: 9000, lastPort: 8000, root: "~/root" }],
  ])("rejects %s", (_label, value) => {
    const fixture = makeFixture();
    writeConfig(fixture, value);
    expect(() => readConfig(fixture.home)).toThrow(/Invalid configuration.*\.alproject\.json/);
  });

  it("rejects relative configured paths", () => {
    const fixture = makeFixture();
    writeConfig(fixture, { firstPort: 8000, lastPort: 9000, root: "root" });
    expect(() => readConfig(fixture.home)).toThrow(/root: Path must be absolute/);
  });

  it.each(["root", "parent"])("rejects a missing %s directory", (missingField) => {
    const fixture = makeFixture();
    const value =
      missingField === "root"
        ? { firstPort: 8000, lastPort: 9000, root: "~/missing" }
        : {
            firstPort: 8000,
            lastPort: 9000,
            projectParents: ["~/missing"],
            root: "~/root",
          };
    writeConfig(fixture, value);
    expect(() => readConfig(fixture.home)).toThrow(/directory is missing or inaccessible/);
  });

  it("rejects a configured file in place of a directory", () => {
    const fixture = makeFixture();
    const filePath = join(fixture.home, "file");
    writeFileSync(filePath, "not a directory");
    writeConfig(fixture, { firstPort: 8000, lastPort: 9000, root: filePath });
    expect(() => readConfig(fixture.home)).toThrow(/path is not a directory/);
  });
});

describe("readConfigIfPresent", () => {
  it("returns no configuration when the file is absent", () => {
    const fixture = makeFixture();

    expect(readConfigIfPresent(fixture.home)).toBeUndefined();
  });

  it("still rejects an invalid configuration file", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, CONFIG_FILENAME), "{");

    expect(() => readConfigIfPresent(fixture.home)).toThrow(/Invalid JSON.*\.alproject\.json/);
  });
});

interface Fixture {
  home: string;
  root: string;
}

function makeFixture(): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-config-"));
  const home = join(fixtureDir, "home");
  const root = join(home, "root");
  mkdirSync(root, { recursive: true });
  return { home, root };
}

function writeConfig(fixture: Fixture, value: object): void {
  writeFileSync(join(fixture.home, CONFIG_FILENAME), JSON.stringify(value));
}
