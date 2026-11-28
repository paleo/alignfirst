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

import { seedFiles } from "../src/file-entries.js";
import { ConfigError, WorkspaceError } from "../src/errors.js";
import { assertFileDestination } from "../src/file-destinations.js";
import { withRegistryLock } from "../src/registry-lock.js";
import { assertRegistryOwnership } from "../src/registry-ownership.js";
import { writeRegistry } from "../src/registry-storage.js";
import { readWorkspaces } from "../src/workspaces.js";

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
    ".local-wt/workspace-registry/new-sidecar",
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
    ).rejects.toThrow(ConfigError);
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
      expect(() => assertFileDestination(main, path)).toThrow(ConfigError);
    }
    expect(readFileSync(join(registry, "workspaces.json"), "utf8")).toBe("original");
    const selected = join(foreign, registryDir);
    const before = readFileSync(join(selected, "workspaces.json"), "utf8");
    symlinkSync(selected, join(main, "selected-registry"));
    expect(() => assertFileDestination(main, "selected-registry/new", selected)).toThrow(
      ConfigError,
    );
    expect(readFileSync(join(selected, "workspaces.json"), "utf8")).toBe(before);
  });
});

describe("main registry ownership", () => {
  it.each(["runtime", "workspaceFile", "lock"])(
    "refuses a foreign %s link before reads, mutation or locking",
    async (location) => {
      const registry = join(main, registryDir);
      if (location === "runtime") {
        symlinkSync(join(foreign, ".local-wt"), join(main, ".local-wt"));
      } else {
        mkdirSync(registry, { recursive: true });
        const filename = location === "lock" ? "workspaces.lock" : "workspaces.json";
        const target = join(foreign, registryDir, filename);
        if (location === "lock") writeFileSync(target, "999999999:foreign");
        symlinkSync(target, join(registry, filename));
      }
      const before = readdirSync(join(foreign, registryDir)).map((file) => [
        file,
        readFileSync(join(foreign, registryDir, file), "utf8"),
      ]);
      if (location !== "lock") {
        expect(() => readWorkspaces(main, registryDir)).toThrow(WorkspaceError);
        expect(() =>
          writeRegistry(join(registry, "workspaces.json"), {}, { type: "object" }, main),
        ).toThrow(WorkspaceError);
      }
      if (location !== "workspaceFile") {
        let ran = false;
        await expect(
          withRegistryLock(main, registryDir, () => {
            ran = true;
          }),
        ).rejects.toThrow(WorkspaceError);
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
      expect(() => assertRegistryOwnership(main, linked, registryDir)).toThrow(WorkspaceError);
    },
  );
});
