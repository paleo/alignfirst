import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { git, runMain, writeRegistry } from "./helpers.js";
import {
  commit,
  removeWorkspaceFixtures,
  runWorkspace as run,
  workspaceFixture as fixture,
} from "./workspace-fixture.js";

afterEach(removeWorkspaceFixtures);

describe("work-files preflight", () => {
  it.each(["trackedPlans", "unignoredPlans"])(
    "refuses %s before branch/destination/log writes",
    async (kind) => {
      const fx = fixture();
      if (kind === "trackedPlans") {
        writeFileSync(join(fx.repo, ".plans/note"), "tracked");
        git(fx.repo, "add", "-f", ".plans");
      } else writeFileSync(join(fx.repo, ".gitignore"), "/.local-wt/\n");
      commit(fx.repo);
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(existsSync(fx.target)).toBe(false);
      expect(git(fx.repo, "branch", "--list", "topic")).toBe("");
      expect(existsSync(join(fx.repo, ".local-wt/logs"))).toBe(false);
    },
  );

  it.each(["missingCompanion", "missingPlans"])(
    "never provisions %s before creation",
    async (kind) => {
      const fx = fixture();
      const companion = join(fx.home, ".alignfirst/companions/app");
      if (kind === "missingPlans") mkdirSync(companion, { recursive: true });
      writeRegistry(fx.home, {
        projects: { [fx.repo]: { dir: "app", items: { ".plans": "companion" } } },
      });
      const registry = join(fx.home, ".alignfirst/companions/registry.json");
      const bytes = readFileSync(registry);
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code).toBe(1);
      expect(existsSync(join(companion, ".plans"))).toBe(false);
      expect(existsSync(fx.target)).toBe(false);
      expect(readFileSync(registry)).toEqual(bytes);
    },
  );

  it("refuses explicit sharing of reserved runtime storage", async () => {
    const fx = fixture();
    writeFileSync(
      join(fx.repo, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, workspace: { sharedDirs: [".local-wt/data"] } }),
    );
    commit(fx.repo);
    const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(existsSync(join(fx.target, ".plans"))).toBe(false);
  });

  it.each(["companion", "project"])(
    "preserves %s plans selection, separate sessions and companion bytes",
    async (selection) => {
      const fx = fixture();
      const companion = join(fx.home, ".alignfirst/companions/app");
      mkdirSync(join(companion, ".plans"), { recursive: true });
      writeRegistry(fx.home, {
        projects: {
          [fx.repo]: { dir: "app", items: { ".plans": selection, _aligndev: "companion" } },
        },
      });
      const registry = join(fx.home, ".alignfirst/companions/registry.json");
      const bytes = readFileSync(registry);
      if (selection === "companion") {
        writeFileSync(join(fx.repo, ".plans/unused"), "keep");
        git(fx.repo, "add", "-f", ".plans");
        commit(fx.repo);
      }
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(registry)).toEqual(bytes);
      const config = await runMain(["config", "--json"], { cwd: fx.target, home: fx.home });
      const locations = JSON.parse(config.stdout).locations;
      expect(realpathSync(locations[".plans"].path)).toBe(
        selection === "companion" ? join(companion, ".plans") : join(fx.repo, ".plans"),
      );
      expect(locations._aligndev.path).toBe(join(companion, ".plans"));
      if (selection === "companion")
        expect(readFileSync(join(fx.target, ".plans/unused"), "utf8")).toBe("keep");
    },
  );
});

describe("registry ownership at the public boundary", () => {
  it("preserves registry bytes before rejecting a run-file destination through an alias", async () => {
    const fx = fixture();
    expect((await run(fx, ["setup"])).code).toBe(0);
    const registry = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
    const bytes = readFileSync(registry);
    symlinkSync(join(fx.repo, ".local-wt/workspace-registry"), join(fx.repo, "alias"));
    const marker = join(fx.root, "producer-ran");
    const manifest = {
      schemaVersion: 1,
      devServer: {
        runFiles: [
          {
            path: "alias/workspaces.json",
            source: {
              kind: "content",
              content: {
                command: {
                  run: [
                    process.execPath,
                    "-e",
                    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('{}')`,
                  ],
                },
              },
            },
          },
        ],
        servers: [
          {
            kind: "spawn",
            name: "app",
            exec: { run: [process.execPath, "-e", ""] },
            ready: { log: "ready" },
          },
        ],
      },
    };
    const file = join(fx.repo, "alignfirst.json");
    writeFileSync(file, JSON.stringify(manifest));
    const result = await runMain(["dev", "setup"], { cwd: fx.repo, home: fx.home });
    expect(result.code).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(registry)).toEqual(bytes);
    manifest.devServer.runFiles[0].path = ".local-wt/application.json";
    writeFileSync(file, JSON.stringify(manifest));
    const sidecar = await runMain(["dev", "setup"], { cwd: fx.repo, home: fx.home });
    expect(sidecar.code, sidecar.stderr).toBe(0);
    expect(readFileSync(join(fx.repo, ".local-wt/application.json"), "utf8")).toBe("{}");
  });

  it("rejects a linked registry belonging to another repository before dispatch", async () => {
    const fx = fixture();
    const foreign = fixture();
    expect((await run(foreign, ["setup"])).code).toBe(0);
    expect((await run(fx, ["setup", "-c", "topic", "--path", fx.target])).code).toBe(0);
    const victim = join(foreign.repo, ".local-wt/workspace-registry/workspaces.json");
    const bytes = readFileSync(victim);
    const link = join(fx.target, ".local-wt/workspace-registry");
    rmSync(link);
    symlinkSync(join(foreign.repo, ".local-wt/workspace-registry"), link);
    for (const args of [
      ["workspace", "list", "--json"],
      ["dev", "down"],
    ]) {
      const result = await runMain(args, { cwd: fx.target, home: fx.home });
      expect(result.code).toBe(1);
      expect(readFileSync(victim)).toEqual(bytes);
    }
  });
});

describe("protected deletion", () => {
  it.each(["extraShared", "plans", "companion", "sessions", "invalidRegistry"])(
    "force preserves protected %s targets",
    async (kind) => {
      const fx = fixture();
      git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
      const shared = join(fx.target, "protected");
      mkdirSync(shared);
      writeFileSync(join(shared, "keep"), "shared bytes");
      if (kind === "extraShared") {
        symlinkSync(shared, join(fx.repo, ".shared"));
        writeFileSync(
          join(fx.repo, "alignfirst.json"),
          JSON.stringify({ schemaVersion: 1, workspace: { sharedDirs: [".shared"] } }),
        );
      }
      if (kind === "plans") {
        rmSync(join(fx.repo, ".plans"), { recursive: true });
        symlinkSync(shared, join(fx.repo, ".plans"));
      }
      if (kind === "companion" || kind === "sessions") {
        mkdirSync(join(shared, ".plans"));
        writeRegistry(fx.home, {
          projects: {
            [fx.repo]: {
              dir: shared,
              items: kind === "sessions" ? { ".plans": "project", _aligndev: "companion" } : {},
            },
          },
        });
      }
      if (kind === "invalidRegistry") {
        writeRegistry(fx.home, { projects: {} });
        writeFileSync(join(fx.home, ".alignfirst/companions/registry.json"), "{broken");
      }
      const registrations = git(fx.repo, "worktree", "list", "--porcelain", "-z");
      const result = await run(fx, ["remove", fx.target, "--force", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared bytes");
      expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(registrations);
    },
  );
});
