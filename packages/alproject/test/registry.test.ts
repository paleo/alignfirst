import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AlprojectConfig } from "../src/config.js";
import { readRegistry, REGISTRY_FILENAME, registryPath } from "../src/registry.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("readRegistry", () => {
  it("returns an empty schema-version-2 registry when the file is absent", () => {
    const fixture = makeFixture();
    expect(readRegistry(fixture.config)).toEqual({ projects: [], schemaVersion: 2 });
    expect(registryPath(fixture.config)).toBe(join(fixture.root, REGISTRY_FILENAME));
  });

  it("reads valid schema-version-2 projects", () => {
    const fixture = makeFixture();
    const projectA = makeProject(fixture, "a");
    const projectB = makeProject(fixture, "b");
    const registry = {
      projects: [
        { path: projectA },
        {
          path: projectB,
          ports: { basePort: 8000, maxWorkspaces: 2, portsPerWorkspace: 10 },
        },
      ],
      schemaVersion: 2,
    };
    writeRegistry(fixture, registry);

    expect(readRegistry(fixture.config)).toEqual(registry);
  });

  it("migrates a legacy version-1 registry", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "legacy");
    writeRegistry(fixture, { projects: [{ path: project }], version: 1 });

    expect(readRegistry(fixture.config)).toEqual({
      projects: [{ path: project }],
      schemaVersion: 2,
    });
  });

  it("reports malformed JSON with the registry path", () => {
    const fixture = makeFixture();
    writeFileSync(registryPath(fixture.config), "{");
    expect(() => readRegistry(fixture.config)).toThrow(/Invalid registry.*invalid JSON/);
  });

  it.each([
    ["unsupported legacy version", { projects: [], version: 2 }],
    ["unsupported schema version", { projects: [], schemaVersion: 1 }],
    ["both version fields", { projects: [], schemaVersion: 2, version: 1 }],
    ["missing projects", { version: 1 }],
    ["non-array projects", { projects: {}, version: 1 }],
    ["unknown registry field", { extra: true, projects: [], version: 1 }],
    ["unknown project field", { projects: [{ extra: true, path: "/project" }], version: 1 }],
    ["empty project path", { projects: [{ path: "" }], version: 1 }],
    ["non-string project path", { projects: [{ path: 42 }], version: 1 }],
    ["non-object ports", { projects: [{ path: "/project", ports: 42 }], version: 1 }],
    [
      "false port-range override",
      {
        projects: [
          {
            path: "/project",
            ports: {
              allowOutsidePortRange: false,
              basePort: 8000,
              maxWorkspaces: 1,
              portsPerWorkspace: 1,
            },
          },
        ],
        version: 1,
      },
    ],
    [
      "unknown port field",
      {
        projects: [
          {
            path: "/project",
            ports: {
              basePort: 8000,
              extra: true,
              maxWorkspaces: 1,
              portsPerWorkspace: 1,
            },
          },
        ],
        version: 1,
      },
    ],
    [
      "missing port field",
      {
        projects: [{ path: "/project", ports: { basePort: 8000, portsPerWorkspace: 1 } }],
        version: 1,
      },
    ],
    ...invalidPortFields(),
  ])("rejects %s", (_label, registry) => {
    const fixture = makeFixture();
    writeRegistry(fixture, registry);
    expect(() => readRegistry(fixture.config)).toThrow(/Invalid registry/);
  });

  it("rejects relative and non-normalized project paths", () => {
    const fixture = makeFixture();
    writeRegistry(fixture, {
      projects: [{ path: "relative" }],
      schemaVersion: 2,
    });
    expect(() => readRegistry(fixture.config)).toThrow(/project path must be absolute/);

    writeRegistry(fixture, {
      projects: [{ path: `${fixture.root}/missing/../project` }],
      schemaVersion: 2,
    });
    expect(() => readRegistry(fixture.config)).toThrow(/project path must be canonical/);
  });

  it("rejects duplicate project paths", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "project");
    writeRegistry(fixture, {
      projects: [{ path: project }, { path: project }],
      version: 1,
    });
    expect(() => readRegistry(fixture.config)).toThrow(`duplicate project path: ${project}`);
  });

  it.each([
    ["below", 7999, 1, 1],
    ["above", 9001, 1, 1],
    ["past inclusive end", 8995, 3, 3],
    ["unsafe multiplication", 8000, Number.MAX_SAFE_INTEGER, 2],
  ])("rejects an allocation %s the configured range", (_label, basePort, count, size) => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "project");
    writeRegistry(fixture, {
      projects: [
        { path: project, ports: { basePort, maxWorkspaces: count, portsPerWorkspace: size } },
      ],
      version: 1,
    });
    expect(() => readRegistry(fixture.config)).toThrow(/Invalid registry/);
  });

  it("accepts an allocation ending exactly at lastPort", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "project");
    const registry = {
      projects: [
        { path: project, ports: { basePort: 8991, maxWorkspaces: 2, portsPerWorkspace: 5 } },
      ],
      schemaVersion: 2,
    };
    writeRegistry(fixture, registry);
    expect(readRegistry(fixture.config)).toEqual(registry);
  });

  it("accepts a marked allocation outside configured ranges", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "external");
    fixture.config.projectParents[0].portRange = { first: 8500, last: 8599 };
    const registry = {
      projects: [
        {
          path: project,
          ports: {
            allowOutsidePortRange: true,
            basePort: 9001,
            maxWorkspaces: 1,
            portsPerWorkspace: 10,
          },
        },
      ],
      schemaVersion: 2,
    };
    writeRegistry(fixture, registry);

    expect(readRegistry(fixture.config)).toEqual(registry);
  });

  it("rejects an override allocation beyond the TCP port range", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "external");
    writeRegistry(fixture, {
      projects: [
        {
          path: project,
          ports: {
            allowOutsidePortRange: true,
            basePort: 65_535,
            maxWorkspaces: 1,
            portsPerWorkspace: 2,
          },
        },
      ],
      version: 1,
    });

    expect(() => readRegistry(fixture.config)).toThrow(/exceeds port 65535/);
  });

  it("rejects an allocation outside its parent-specific port range", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "project");
    fixture.config.projectParents[0].portRange = { first: 8500, last: 8599 };
    writeRegistry(fixture, {
      projects: [
        { path: project, ports: { basePort: 8400, maxWorkspaces: 1, portsPerWorkspace: 10 } },
      ],
      version: 1,
    });

    expect(() => readRegistry(fixture.config)).toThrow(/outside its available parent port range/);
  });

  it("rejects an existing shared allocation inside another parent's reserved range", () => {
    const fixture = makeFixture();
    const project = makeProject(fixture, "project");
    fixture.config.projectParents.push({
      path: join(dirname(fixture.root), "dedicated"),
      portRange: { first: 8500, last: 8599 },
    });
    writeRegistry(fixture, {
      projects: [
        { path: project, ports: { basePort: 8500, maxWorkspaces: 1, portsPerWorkspace: 10 } },
      ],
      version: 1,
    });

    expect(() => readRegistry(fixture.config)).toThrow(/outside its available parent port range/);
  });

  it("rejects overlapping and duplicate port reservations", () => {
    const fixture = makeFixture();
    const projectA = makeProject(fixture, "a");
    const projectB = makeProject(fixture, "b");
    writeRegistry(fixture, {
      projects: [
        {
          path: projectA,
          ports: { basePort: 8000, maxWorkspaces: 2, portsPerWorkspace: 10 },
        },
        {
          path: projectB,
          ports: { basePort: 8019, maxWorkspaces: 1, portsPerWorkspace: 2 },
        },
      ],
      version: 1,
    });
    expect(() => readRegistry(fixture.config)).toThrow(/port allocations overlap/);

    writeRegistry(fixture, {
      projects: [
        {
          path: projectA,
          ports: { basePort: 8000, maxWorkspaces: 1, portsPerWorkspace: 1 },
        },
        {
          path: projectB,
          ports: { basePort: 8000, maxWorkspaces: 1, portsPerWorkspace: 1 },
        },
      ],
      version: 1,
    });
    expect(() => readRegistry(fixture.config)).toThrow(/port allocations overlap/);
  });
});

interface Fixture {
  config: AlprojectConfig;
  root: string;
}

function makeFixture(): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-registry-"));
  const root = join(fixtureDir, "root");
  mkdirSync(root);
  return {
    config: {
      configPath: join(fixtureDir, ".alproject.json"),
      projectParents: [{ path: root }],
      root: { path: root, portRange: { first: 8000, last: 9000 } },
    },
    root,
  };
}

function makeProject(fixture: Fixture, name: string): string {
  const project = join(fixture.root, name);
  mkdirSync(project);
  return project;
}

function writeRegistry(fixture: Fixture, value: object): void {
  writeFileSync(registryPath(fixture.config), JSON.stringify(value));
}

function invalidPortFields(): [string, object][] {
  return [
    invalidPortField("non-positive basePort", { basePort: 0 }),
    invalidPortField("non-integer basePort", { basePort: 8000.5 }),
    invalidPortField("non-positive maxWorkspaces", { maxWorkspaces: 0 }),
    invalidPortField("non-integer maxWorkspaces", { maxWorkspaces: 1.5 }),
    invalidPortField("non-positive portsPerWorkspace", { portsPerWorkspace: 0 }),
    invalidPortField("non-integer portsPerWorkspace", { portsPerWorkspace: 1.5 }),
  ];
}

function invalidPortField(label: string, override: object): [string, object] {
  return [
    label,
    {
      projects: [
        {
          path: "/project",
          ports: { basePort: 8000, maxWorkspaces: 1, portsPerWorkspace: 1, ...override },
        },
      ],
      version: 1,
    },
  ];
}
