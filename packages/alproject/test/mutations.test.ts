import {
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AlprojectConfig } from "../src/config.js";
import { registerProject, unregisterProject } from "../src/mutations.js";
import { readRegistry, registryPath } from "../src/registry.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("registerProject", () => {
  it("registers root-relative and absolute main worktrees without ports", async () => {
    const fixture = makeFixture();
    const relative = makeProject(fixture.root, "relative");
    const absolute = makeProject(fixture.parent, "absolute");

    await expect(registerProject(fixture.config, "relative")).resolves.toEqual({ path: relative });
    await expect(registerProject(fixture.config, absolute)).resolves.toEqual({ path: absolute });
    expect(readRegistry(fixture.config).projects).toEqual([{ path: relative }, { path: absolute }]);
  });

  it("requires an existing direct-child main worktree under an allowed parent", async () => {
    const fixture = makeFixture();
    const nestedParent = join(fixture.root, "container");
    mkdirSync(nestedParent);
    const nested = makeProject(nestedParent, "nested");
    const linked = join(fixture.root, "linked");
    mkdirSync(linked);
    writeFileSync(join(linked, ".git"), "gitdir: elsewhere\n");

    await expect(registerProject(fixture.config, "missing")).rejects.toThrow(/existing Git/);
    await expect(registerProject(fixture.config, nested)).rejects.toThrow(/direct child/);
    await expect(registerProject(fixture.config, linked)).rejects.toThrow(/existing Git/);
    expect(existsSync(registryPath(fixture.config))).toBe(false);
  });

  it("rejects duplicate registration and preserves the registry", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");
    await registerProject(fixture.config, project);
    const before = readFileSync(registryPath(fixture.config), "utf8");

    await expect(registerProject(fixture.config, project)).rejects.toThrow(/already registered/);
    expect(readFileSync(registryPath(fixture.config), "utf8")).toBe(before);
  });

  it("requires both positive safe-integer port options before locking", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");

    await expect(
      registerProject(fixture.config, project, { portsPerWorkspace: 2 }),
    ).rejects.toThrow(/provided together/);
    await expect(
      registerProject(fixture.config, project, { maxWorkspaces: 2, portsPerWorkspace: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(registerProject(fixture.config, project, { basePort: 8000 })).rejects.toThrow(
      /requires portsPerWorkspace and maxWorkspaces/,
    );
    await expect(
      registerProject(fixture.config, project, { allowOutsidePortRange: true }),
    ).rejects.toThrow(/requires basePort/);
    expect(existsSync(registryPath(fixture.config))).toBe(false);
  });

  it("allocates the lowest range, reuses a released hole, and reports inclusive ends", async () => {
    const fixture = makeFixture(8000, 8029);
    const a = makeProject(fixture.root, "a");
    const b = makeProject(fixture.root, "b");
    const c = makeProject(fixture.root, "c");
    const options = { maxWorkspaces: 2, portsPerWorkspace: 5 };

    expect((await registerProject(fixture.config, a, options)).ports).toEqual({
      basePort: 8000,
      endPort: 8009,
      ...options,
    });
    expect((await registerProject(fixture.config, b, options)).ports?.basePort).toBe(8010);
    await unregisterProject(fixture.config, a);
    expect((await registerProject(fixture.config, c, options)).ports?.basePort).toBe(8000);
  });

  it("claims an exact available base port and preserves the registry on conflicts", async () => {
    const fixture = makeFixture(8000, 8029);
    const a = makeProject(fixture.root, "a");
    const b = makeProject(fixture.root, "b");
    const options = { basePort: 8010, maxWorkspaces: 2, portsPerWorkspace: 5 };

    expect((await registerProject(fixture.config, a, options)).ports).toEqual({
      basePort: 8010,
      endPort: 8019,
      maxWorkspaces: 2,
      portsPerWorkspace: 5,
    });
    const before = readFileSync(registryPath(fixture.config), "utf8");
    await expect(registerProject(fixture.config, b, options)).rejects.toThrow(/not available/);
    expect(readFileSync(registryPath(fixture.config), "utf8")).toBe(before);
  });

  it("claims and persists an exact range outside configured ranges only with an override", async () => {
    const fixture = makeFixture(8000, 8009);
    fixture.config.projectParents[1].portRange = { first: 8000, last: 8009 };
    const project = makeProject(fixture.parent, "external");
    const request = { basePort: 9000, maxWorkspaces: 2, portsPerWorkspace: 5 };

    await expect(registerProject(fixture.config, project, request)).rejects.toThrow(/outside/);
    await expect(
      registerProject(fixture.config, project, {
        allowOutsidePortRange: true,
        ...request,
      }),
    ).resolves.toEqual({
      path: project,
      ports: {
        allowOutsidePortRange: true,
        basePort: 9000,
        endPort: 9009,
        maxWorkspaces: 2,
        portsPerWorkspace: 5,
      },
    });
    expect(readRegistry(fixture.config).projects[0].ports?.allowOutsidePortRange).toBe(true);
  });

  it("keeps overlap checks for allocations outside configured ranges", async () => {
    const fixture = makeFixture(8000, 8009);
    const a = makeProject(fixture.root, "a");
    const b = makeProject(fixture.root, "b");
    const options = {
      allowOutsidePortRange: true,
      basePort: 9000,
      maxWorkspaces: 1,
      portsPerWorkspace: 10,
    };

    await registerProject(fixture.config, a, options);
    await expect(registerProject(fixture.config, b, options)).rejects.toThrow(/overlaps/);
  });

  it("reserves dedicated parent ranges from the shared allocation pool", async () => {
    const fixture = makeFixture(8000, 8029);
    fixture.config.projectParents[1].portRange = { first: 8010, last: 8019 };
    const sharedA = makeProject(fixture.root, "shared-a");
    const sharedB = makeProject(fixture.root, "shared-b");
    const dedicated = makeProject(fixture.parent, "dedicated");
    const options = { maxWorkspaces: 2, portsPerWorkspace: 5 };

    await expect(
      registerProject(fixture.config, sharedA, { basePort: 8010, ...options }),
    ).rejects.toThrow(/outside/);
    await expect(
      registerProject(fixture.config, dedicated, { basePort: 8000, ...options }),
    ).rejects.toThrow(/outside/);
    expect((await registerProject(fixture.config, sharedA, options)).ports?.basePort).toBe(8000);
    expect((await registerProject(fixture.config, sharedB, options)).ports?.basePort).toBe(8020);
    expect((await registerProject(fixture.config, dedicated, options)).ports?.basePort).toBe(8010);
  });

  it("uses registry reservations only and preserves an exhausted registry", async () => {
    const fixture = makeFixture(8000, 8009);
    const a = makeProject(fixture.root, "a");
    const b = makeProject(fixture.root, "b");
    await registerProject(fixture.config, a, { maxWorkspaces: 2, portsPerWorkspace: 5 });
    const before = readFileSync(registryPath(fixture.config), "utf8");

    await expect(
      registerProject(fixture.config, b, { maxWorkspaces: 1, portsPerWorkspace: 1 }),
    ).rejects.toThrow(/No contiguous block/);
    expect(readFileSync(registryPath(fixture.config), "utf8")).toBe(before);
  });

  it("serializes concurrent registrations into distinct ranges", async () => {
    const fixture = makeFixture(8000, 8019);
    const a = makeProject(fixture.root, "a");
    const b = makeProject(fixture.root, "b");
    const options = { maxWorkspaces: 2, portsPerWorkspace: 5 };

    const results = await Promise.all([
      registerProject(fixture.config, a, options),
      registerProject(fixture.config, b, options),
    ]);
    expect(results.map((result) => result.ports?.basePort).toSorted()).toEqual([8000, 8010]);
    expect(readRegistry(fixture.config).projects).toHaveLength(2);
  });
});

describe("unregisterProject", () => {
  it("removes only registry state after the project path disappears", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");
    const sibling = join(project, "README.md");
    writeFileSync(sibling, "keep\n");
    await registerProject(fixture.config, project);
    renameSync(project, `${project}-moved`);

    await expect(unregisterProject(fixture.config, "project")).resolves.toBe(project);
    expect(readRegistry(fixture.config).projects).toEqual([]);
    expect(existsSync(`${project}-moved/README.md`)).toBe(true);
  });

  it("rejects unknown paths without creating or changing a registry", async () => {
    const fixture = makeFixture();
    await expect(unregisterProject(fixture.config, "unknown")).rejects.toThrow(/not registered/);
    expect(existsSync(registryPath(fixture.config))).toBe(false);

    const known = makeProject(fixture.root, "known");
    await registerProject(fixture.config, known);
    const before = readFileSync(registryPath(fixture.config), "utf8");
    await expect(unregisterProject(fixture.config, "unknown")).rejects.toThrow(/not registered/);
    expect(readFileSync(registryPath(fixture.config), "utf8")).toBe(before);
  });
});

describe("atomic registry mutation", () => {
  it("writes complete JSON with a trailing newline", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");
    await registerProject(fixture.config, project);

    const content = readFileSync(registryPath(fixture.config), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content)).toEqual({ projects: [{ path: project }], version: 1 });
  });

  it("syncs the registry file and its parent directory", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");
    const syncedDescriptors: number[] = [];

    await registerProject(
      fixture.config,
      project,
      {},
      {
        atomicWriteOperations: {
          fsync: (descriptor) => {
            syncedDescriptors.push(descriptor);
            fsyncSync(descriptor);
          },
        },
      },
    );

    expect(syncedDescriptors).toHaveLength(2);
  });

  it("ignores a directory sync failure after the rename", async () => {
    const fixture = makeFixture();
    const project = makeProject(fixture.root, "project");

    await expect(
      registerProject(
        fixture.config,
        project,
        {},
        {
          atomicWriteOperations: {
            open: (path, flags, mode) => {
              if (flags === "r") {
                throw Object.assign(new Error("EISDIR: illegal operation on a directory"), {
                  code: "EISDIR",
                });
              }
              return openSync(path, flags, mode);
            },
          },
        },
      ),
    ).resolves.toEqual({ path: project });
    expect(readRegistry(fixture.config).projects).toEqual([{ path: project }]);
  });

  it("cleans temporary state, releases the lock, and preserves the registry on failure", async () => {
    const fixture = makeFixture();
    const existing = makeProject(fixture.root, "existing");
    const failed = makeProject(fixture.root, "failed");
    await registerProject(fixture.config, existing);
    const before = readFileSync(registryPath(fixture.config), "utf8");

    await expect(
      registerProject(
        fixture.config,
        failed,
        {},
        {
          atomicWriteOperations: {
            rename: () => {
              throw new Error("injected rename failure");
            },
          },
        },
      ),
    ).rejects.toThrow(/Cannot atomically replace/);
    expect(readFileSync(registryPath(fixture.config), "utf8")).toBe(before);
    expect(readdirSync(fixture.root).filter((name) => name.includes(".tmp-"))).toEqual([]);
    await expect(registerProject(fixture.config, failed)).resolves.toEqual({ path: failed });
  });
});

interface Fixture {
  config: AlprojectConfig;
  parent: string;
  root: string;
}

function makeFixture(firstPort = 8000, lastPort = 9000): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-mutations-"));
  const root = join(fixtureDir, "root");
  const parent = join(fixtureDir, "parent");
  mkdirSync(root);
  mkdirSync(parent);
  return {
    config: {
      configPath: join(fixtureDir, ".alproject.json"),
      projectParents: [{ path: root }, { path: parent }],
      root: { path: root, portRange: { first: firstPort, last: lastPort } },
    },
    parent,
    root,
  };
}

function makeProject(parent: string, name: string): string {
  const project = join(parent, name);
  mkdirSync(join(project, ".git"), { recursive: true });
  return project;
}
