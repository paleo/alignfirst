import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDevServers, writeDevServers } from "../src/dev-servers-registry.js";
import { seedFiles } from "../src/file-entries.js";
import { assertFileDestination } from "../src/file-destinations.js";
import { withRegistryLock } from "../src/registry-lock.js";
import { assertRegistryOwnership } from "../src/registry-ownership.js";
import { writeRegistry } from "../src/registry-storage.js";
import { readWorkspaces, writeWorkspaces } from "../src/workspaces.js";

const registryDir = ".local-wt/workspace-registry";
let scratch: string;
let main: string;
let foreign: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "registry-ownership-"));
  main = join(scratch, "main");
  foreign = join(scratch, "foreign");
  mkdirSync(main);
  mkdirSync(join(foreign, registryDir), { recursive: true });
  writeFileSync(join(foreign, registryDir, "workspaces.json"), '{"version":3,"workspaces":{}}\n');
  writeFileSync(join(foreign, registryDir, "dev-servers.json"), '{"version":1,"servers":[]}\n');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("kernel-owned file destinations", () => {
  it.each([
    ".local-wt/workspace-registry/workspaces.json",
    ".local-wt/workspace-registry/dev-servers.json",
    ".local-wt/workspace-registry/workspaces.lock",
    ".local-wt/workspace-registry/new-sidecar",
    ".local-wt/workspace-registry",
    ".local-wt",
  ])("rejects %s before invoking a producer", async (path) => {
    let produced = false;
    await expect(
      seedFiles({
        entries: [
          {
            path,
            source: {
              kind: "content",
              content: () => {
                produced = true;
                return "{}";
              },
            },
          },
        ],
        ctx: { name: "main", currentWorktree: main, mainWorktree: main, isMainWorktree: true },
        existing: "reseed",
        log: { tee: () => {}, verbose: () => {} },
      }),
    ).rejects.toThrow(/registry/i);
    expect(produced).toBe(false);
    expect(existsSync(join(main, path))).toBe(false);
  });

  it("rejects canonical aliases to registry files, directories and their ancestors", () => {
    const registry = join(main, registryDir);
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "workspaces.json"), "original");
    symlinkSync(join(registry, "workspaces.json"), join(main, "file-alias"));
    symlinkSync(registry, join(main, "registry-alias"));
    symlinkSync(dirname(registry), join(main, "runtime-alias"));
    for (const path of ["file-alias", "registry-alias/new", "runtime-alias"]) {
      expect(() => assertFileDestination(main, path)).toThrow(/registry/i);
    }
    expect(readFileSync(join(registry, "workspaces.json"), "utf8")).toBe("original");
    const selected = join(foreign, registryDir);
    const before = readFileSync(join(selected, "workspaces.json"), "utf8");
    symlinkSync(selected, join(main, "selected-registry"));
    expect(() => assertFileDestination(main, "selected-registry/new", selected)).toThrow(
      /registry/i,
    );
    expect(readFileSync(join(selected, "workspaces.json"), "utf8")).toBe(before);
  });

  it("allows application sidecars elsewhere in local runtime storage", async () => {
    const path = ".local-wt/app-summary.json";
    await seedFiles({
      entries: [{ path, source: { kind: "content", content: "application data" } }],
      ctx: { name: "main", currentWorktree: main, mainWorktree: main, isMainWorktree: true },
      existing: "reseed",
      log: { tee: () => {}, verbose: () => {} },
    });
    expect(readFileSync(join(main, path), "utf8")).toBe("application data");
  });
});

describe("main registry ownership", () => {
  it.each(["runtime", "registry", "workspaceFile", "devFile", "lock"])(
    "refuses a foreign %s link before reads, mutation or locking",
    async (location) => {
      const registry = join(main, registryDir);
      if (location === "runtime") {
        symlinkSync(join(foreign, ".local-wt"), join(main, ".local-wt"));
      } else if (location === "registry") {
        mkdirSync(dirname(registry));
        symlinkSync(join(foreign, registryDir), registry);
      } else {
        mkdirSync(registry, { recursive: true });
        const filename =
          location === "workspaceFile"
            ? "workspaces.json"
            : location === "devFile"
              ? "dev-servers.json"
              : "workspaces.lock";
        const target = join(foreign, registryDir, filename);
        if (location === "lock") writeFileSync(target, "999999999:foreign");
        symlinkSync(target, join(registry, filename));
      }
      const before = readdirSync(join(foreign, registryDir)).map((file) => [
        file,
        readFileSync(join(foreign, registryDir, file), "utf8"),
      ]);
      if (location !== "lock") {
        const read = location === "devFile" ? readDevServers : readWorkspaces;
        expect(() => read(main, registryDir)).toThrow(/local|ownership/i);
        const filename = location === "devFile" ? "dev-servers.json" : "workspaces.json";
        expect(() => writeRegistry(join(registry, filename), {}, { type: "object" }, main)).toThrow(
          /local|ownership/i,
        );
      }
      let ran = false;
      if (location !== "workspaceFile" && location !== "devFile") {
        await expect(
          withRegistryLock(main, registryDir, () => {
            ran = true;
          }),
        ).rejects.toThrow(/local|ownership/i);
        expect(ran).toBe(false);
      }
      expect(
        readdirSync(join(foreign, registryDir)).map((file) => [
          file,
          readFileSync(join(foreign, registryDir, file), "utf8"),
        ]),
      ).toEqual(before);
    },
  );

  it("rechecks aliases after an awaited producer without damaging the registry", async () => {
    mkdirSync(join(main, registryDir), { recursive: true });
    const registry = join(main, registryDir, "workspaces.json");
    writeFileSync(registry, "original");
    await expect(
      seedFiles({
        entries: [
          {
            path: "generated.json",
            source: {
              kind: "content",
              content: async () => {
                await Promise.resolve();
                symlinkSync(registry, join(main, "generated.json"));
                return "replacement";
              },
            },
          },
        ],
        ctx: { name: "main", currentWorktree: main, mainWorktree: main, isMainWorktree: true },
        existing: "reseed",
        log: { tee: () => {}, verbose: () => {} },
      }),
    ).rejects.toThrow(/registry/i);
    expect(readFileSync(registry, "utf8")).toBe("original");
  });

  it.each(["foreign", "localDirectory", "broken"])(
    "refuses a linked worktree's %s registry destination",
    (kind) => {
      const linked = join(scratch, "linked");
      mkdirSync(join(linked, ".local-wt"), { recursive: true });
      mkdirSync(join(main, registryDir), { recursive: true });
      if (kind === "localDirectory") mkdirSync(join(linked, registryDir));
      else
        symlinkSync(
          kind === "foreign" ? join(foreign, registryDir) : join(scratch, "missing"),
          join(linked, registryDir),
        );
      expect(() => assertRegistryOwnership(main, linked, registryDir)).toThrow(/own main/i);
    },
  );

  it("allows a linked worktree's own-main registry link but never as a file destination", async () => {
    execFileSync("git", ["init", "-b", "main", main]);
    execFileSync("git", [
      "-C",
      main,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const linked = join(scratch, "linked");
    execFileSync("git", ["-C", main, "worktree", "add", "-b", "linked", linked]);
    mkdirSync(join(main, registryDir), { recursive: true });
    mkdirSync(join(linked, ".local-wt"));
    symlinkSync(join(main, registryDir), join(linked, registryDir));
    expect(() => assertRegistryOwnership(main, linked, registryDir)).not.toThrow();
    await withRegistryLock(main, registryDir, () => {
      writeWorkspaces(main, registryDir, { workspaces: {} });
      writeDevServers(main, registryDir, { servers: [] });
    });
    expect(readWorkspaces(main, registryDir).workspaces).toEqual({});
    expect(readDevServers(main, registryDir)).toEqual({ servers: [] });
    expect(() => assertFileDestination(linked, `${registryDir}/workspaces.json`)).toThrow(
      /registry/i,
    );
  });
});
