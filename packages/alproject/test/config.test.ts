import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  availablePortRanges,
  CONFIG_FILENAME,
  readConfig,
  readConfigIfPresent,
} from "../src/config.js";
import type { AlprojectError } from "../src/errors.js";
import { canonicalizePath, expandHomePath, normalizeAbsolutePath } from "../src/paths.js";

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
});

describe("readConfig", () => {
  it("loads an omitted projectParents field as the canonical root", () => {
    const fixture = makeFixture();
    writeConfig(fixture, configuredRoot("~/root", 8000, 9999));

    expect(readConfig(fixture.home)).toEqual({
      configPath: join(fixture.home, CONFIG_FILENAME),
      projectParents: [{ path: realpathSync(fixture.root) }],
      root: {
        path: realpathSync(fixture.root),
        portRange: { first: 8000, last: 9999 },
      },
    });
  });

  it("uses explicit project parents without adding root", () => {
    const fixture = makeFixture();
    const otherParent = join(fixture.home, "other");
    mkdirSync(otherParent);
    writeConfig(fixture, {
      projectParents: [{ path: "~/other" }],
      ...configuredRoot("~/root", 1, 65535),
    });

    const config = readConfig(fixture.home);
    expect(config.projectParents).toEqual([{ path: realpathSync(otherParent) }]);
    expect(config.projectParents.map((parent) => parent.path)).not.toContain(config.root.path);
  });

  it("rejects canonically duplicate explicit parents", () => {
    const fixture = makeFixture();
    const linkedRoot = join(fixture.home, "linked-root");
    symlinkSync(fixture.root, linkedRoot);
    writeConfig(fixture, {
      projectParents: [{ path: "~/root" }, { path: "~/linked-root" }, { path: "~/root/../root" }],
      ...configuredRoot("~/linked-root"),
    });

    expect(() => readConfig(fixture.home)).toThrow(/duplicate project parent/);
  });

  it("reserves non-overlapping parent port ranges from the shared root range", () => {
    const fixture = makeFixture();
    const dedicated = join(fixture.home, "dedicated");
    const shared = join(fixture.home, "shared");
    mkdirSync(dedicated);
    mkdirSync(shared);
    writeConfig(fixture, {
      projectParents: [
        { path: dedicated, portRange: { first: 8200, last: 8299 } },
        { path: shared },
      ],
      ...configuredRoot("~/root", 8000, 8999),
    });

    const config = readConfig(fixture.home);
    expect(availablePortRanges(config, join(dedicated, "project"))).toEqual([
      { first: 8200, last: 8299 },
    ]);
    expect(availablePortRanges(config, join(shared, "project"))).toEqual([
      { first: 8000, last: 8199 },
      { first: 8300, last: 8999 },
    ]);
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
    ["missing root", {}],
    ["string root", { root: "~/root" }],
    ["unknown field", { extra: true, ...configuredRoot("~/root") }],
    ["empty root path", configuredRoot("")],
    ["non-string root path", configuredRoot(42)],
    ["empty parents", { projectParents: [], ...configuredRoot("~/root") }],
    ["empty parent path", { projectParents: [{ path: "" }], ...configuredRoot("~/root") }],
    ["string parent", { projectParents: ["~/root"], ...configuredRoot("~/root") }],
    ["non-array parents", { projectParents: "~/root", ...configuredRoot("~/root") }],
    [
      "partial parent range",
      {
        projectParents: [{ path: "~/root", portRange: { first: 8000 } }],
        ...configuredRoot("~/root"),
      },
    ],
    ["missing first port", configuredRange({ last: 9000 })],
    ["missing last port", configuredRange({ first: 8000 })],
    ["non-number first port", configuredRange({ first: "8000", last: 9000 })],
    ["non-integer first port", configuredRange({ first: 8000.5, last: 9000 })],
    ["first port below range", configuredRange({ first: 0, last: 9000 })],
    ["non-integer last port", configuredRange({ first: 8000, last: 9000.5 })],
    ["last port above range", configuredRange({ first: 8000, last: 65536 })],
    ["reversed ports", configuredRange({ first: 9000, last: 8000 })],
  ])("rejects %s", (_label, value) => {
    const fixture = makeFixture();
    writeConfig(fixture, value);
    expect(() => readConfig(fixture.home)).toThrow(/Invalid configuration.*\.alproject\.json/);
  });

  it("rejects relative configured paths", () => {
    const fixture = makeFixture();
    writeConfig(fixture, configuredRoot("root"));
    expect(() => readConfig(fixture.home)).toThrow(/root\.path: Path must be absolute/);
  });

  it.each(["root", "parent"])("rejects a missing %s directory", (missingField) => {
    const fixture = makeFixture();
    const value =
      missingField === "root"
        ? configuredRoot("~/missing")
        : {
            projectParents: [{ path: "~/missing" }],
            ...configuredRoot("~/root"),
          };
    writeConfig(fixture, value);
    expect(() => readConfig(fixture.home)).toThrow(/directory is missing or inaccessible/);
  });

  it("rejects a configured file in place of a directory", () => {
    const fixture = makeFixture();
    const filePath = join(fixture.home, "file");
    writeFileSync(filePath, "not a directory");
    writeConfig(fixture, configuredRoot(filePath));
    expect(() => readConfig(fixture.home)).toThrow(/path is not a directory/);
  });

  it.each([
    ["outside root", { first: 7000, last: 8000 }, { first: 8000, last: 9000 }],
    ["reversed", { first: 8500, last: 8400 }, { first: 8000, last: 9000 }],
  ])("rejects a parent port range %s", (_label, portRange, rootRange) => {
    const fixture = makeFixture();
    writeConfig(fixture, {
      projectParents: [{ path: "~/root", portRange }],
      root: { path: "~/root", portRange: rootRange },
    });
    expect(() => readConfig(fixture.home)).toThrow(/Invalid configuration/);
  });

  it("rejects overlapping parent port ranges", () => {
    const fixture = makeFixture();
    const other = join(fixture.home, "other");
    mkdirSync(other);
    writeConfig(fixture, {
      projectParents: [
        { path: "~/root", portRange: { first: 8100, last: 8200 } },
        { path: other, portRange: { first: 8200, last: 8300 } },
      ],
      ...configuredRoot("~/root"),
    });
    expect(() => readConfig(fixture.home)).toThrow(/port ranges overlap/);
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

function configuredRoot(path: unknown, first = 8000, last = 9000): object {
  return { root: { path, portRange: { first, last } } };
}

function configuredRange(portRange: object): object {
  return { root: { path: "~/root", portRange } };
}
