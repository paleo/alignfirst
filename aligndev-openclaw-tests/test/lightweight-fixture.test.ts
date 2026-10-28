import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OLD_HISTORY,
  assertCapturedRequest,
  selectCompanionPlans,
} from "../scripts/lightweight-fixture.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const aligndev = join(root, "packages/aligndev/bin/aligndev.mjs");
const alignfirst = join(root, "packages/alignfirst/bin/alignfirst.mjs");

test("request capture tolerates presentation but retains every requirement", () => {
  const expected =
    "Sur nimbus, sans ticket, améliore le libellé d'export.\n\n- Remplace Export par Download dans label.mjs.\n- Adapte le test label.test.mjs et exécute npm test.\n- Ne pousse rien.";
  const presented =
    "# Demande\nSur nimbus, sans ticket externe, améliore le libellé d’export.\n\n- Remplace « Export » par « Download » dans `label.mjs`.\n- Adapte le test `label.test.mjs` et exécute `npm test`.\n- Ne pousse rien.";
  assertCapturedRequest(expected);
  assertCapturedRequest(presented);
  assertCapturedRequest(presented.replace("Adapte le test", "Adapte"));
  assertCapturedRequest(
    presented
      .replace("Remplace", "Remplacer")
      .replace("Adapte", "Adapter")
      .replace("exécute", "exécuter")
      .replace("Ne pousse rien", "Ne rien pousser"),
  );
  for (const missing of ["sans ticket externe, ", "et exécute `npm test`", "- Ne pousse rien."]) {
    assert.throws(() => assertCapturedRequest(presented.replace(missing, "")), /omitted/);
  }
});

for (const mode of ["shared", "missing", "tracked"] as const) {
  test(`lightweight ${mode}: real creation, discovery/reuse, consultation, cleanup`, () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "side29-lightweight-")));
    const home = join(base, "home");
    const repo = join(base, "nimbus");
    const worktree = join(base, "chosen destination");
    const bin = join(base, "bin");
    mkdirSync(home);
    mkdirSync(repo);
    mkdirSync(bin);
    // Keep npm test from selecting npx instead of the built-source PATH shim.
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("npm_")),
    );
    const env = {
      ...baseEnv,
      HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      ALIGNFIRST_ARCHIVE_THRESHOLD_DAYS: "99999",
    };
    writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\nname = test\nemail = test@local\n");
    writeFileSync(
      join(bin, "alignfirst"),
      `#!${process.execPath}\nimport(${JSON.stringify(alignfirst)});\n`,
      { mode: 0o755 },
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
    const cli = (entry: string, cwd: string, ...args: string[]) => {
      const result = spawnSync(process.execPath, [entry, ...args], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, ".gitignore"), ".plans/\n.local/\n.local-wt/\n");
      const config = {
        schemaVersion: 1,
        conventions: { ticketIdPattern: "^ABC-\\d+$" },
        developerInstructions: "DEVELOPERS.md",
        plans: { autoArchive: true },
        workspace: { finalize: [{ name: "Must be removed", run: ["false"] }] },
        devServer: { maxConcurrentDevServers: 2 },
      };
      writeFileSync(join(repo, "alignfirst.json"), JSON.stringify(config));
      git("add", ".gitignore", "alignfirst.json");
      git("commit", "-qm", "init");
      git("init", "-q", "--bare", "-b", "main", join(base, "origin.git"));
      git("remote", "add", "origin", join(base, "origin.git"));
      git("push", "-qu", "origin", "main");
      // The transformation itself uses real Git and the caller's environment.
      const transformed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {prepareLightweightFixture} from ${JSON.stringify(resolve(root, "aligndev-openclaw-tests/scripts/lightweight-fixture.ts"))}; prepareLightweightFixture(${JSON.stringify({ repo, plans: mode })});`,
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(transformed.status, 0, transformed.stderr);
      const { workspace, devServer, ...retainedConfig } = config;
      assert.deepEqual(
        JSON.parse(cli(alignfirst, repo, "config", "--json")).config,
        retainedConfig,
      );
      assert.match(cli(alignfirst, repo, "developer-instructions"), /small ESM library/);
      assert.equal(
        JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dependencies,
        undefined,
      );
      execFileSync(process.execPath, ["--test", "label.test.mjs"], {
        cwd: repo,
        env,
        stdio: "pipe",
      });
      let plans = join(repo, ".plans");
      if (mode !== "shared") {
        const failed = spawnSync(
          process.execPath,
          [
            alignfirst,
            "workspace",
            "setup",
            "--path",
            worktree,
            "-c",
            "side-1/label",
            "--from",
            "main",
            "--json",
          ],
          { cwd: repo, env, encoding: "utf8" },
        );
        assert.equal(failed.status, 1);
        assert.equal(failed.stdout, "");
        assert.equal(existsSync(worktree), false);
        assert.equal(git("branch", "--list", "side-1/label"), "");
        assert.equal(existsSync(join(home, ".alignfirst/companions/registry.json")), false);
        cli(alignfirst, repo, "companion", "register");
        const registry = join(home, ".alignfirst/companions/registry.json");
        const value = JSON.parse(readFileSync(registry, "utf8"));
        const key = Object.keys(value.projects)[0];
        value.projects[key].aligndev = { profile: "keep-profile" };
        writeFileSync(
          join(home, ".alignfirst/aligndev.settings.json"),
          JSON.stringify({
            code: { profiles: { "keep-profile": { agent: "codex" } } },
          }),
        );
        value.projects[key].items = { docs: "project" };
        value.projects["/unrelated"] = { aligndev: { profile: "unrelated-profile" } };
        writeFileSync(registry, JSON.stringify(value));
        plans = selectCompanionPlans(home, repo);
        writeFileSync(join(plans, "keep.md"), "existing companion data\n");
        assert.equal(selectCompanionPlans(home, repo), plans);
        const prepared = JSON.parse(readFileSync(registry, "utf8"));
        assert.equal(prepared.projects[key].aligndev.profile, "keep-profile");
        assert.equal(prepared.projects[key].items.docs, "project");
        assert.deepEqual(prepared.projects["/unrelated"], value.projects["/unrelated"]);
      }
      const reservation = cli(alignfirst, repo, "ticket", "--side");
      assert.match(reservation, /side-1/);
      writeFileSync(join(plans, "side-1/A1-request.md"), "Change Export to Download.\n");
      const added = JSON.parse(
        cli(
          alignfirst,
          repo,
          "workspace",
          "setup",
          "--path",
          worktree,
          "-c",
          "side-1/label",
          "--from",
          "main",
          "--json",
        ),
      );
      assert.equal(added.workspace.path, worktree);
      assert.equal(added.workspace.preparation, "ready");
      assert.equal(added.workspace.recipe, "defaults");
      assert.equal(
        JSON.parse(cli(alignfirst, worktree, "config", "--json")).locations[".plans"].path,
        mode === "shared" ? join(worktree, ".plans") : plans,
      );
      assert.equal(
        readFileSync(join(plans, "side-1/A1-request.md"), "utf8"),
        "Change Export to Download.\n",
      );
      const inventory = JSON.parse(cli(alignfirst, repo, "workspace", "list", "--json"));
      const existing = inventory.workspaces.find(
        (entry: { branch: string }) => entry.branch === "side-1/label",
      );
      assert.equal(
        existing.path,
        worktree,
        "reuse/branch consultation discover the exact Git-registered path",
      );
      assert.equal(
        cli(alignfirst, worktree, "workspace", "list", "--json"),
        cli(alignfirst, repo, "workspace", "list", "--json"),
      );
      const duplicate = spawnSync(
        process.execPath,
        [alignfirst, "workspace", "setup", "--path", join(base, "duplicate"), "side-1/label"],
        { cwd: repo, env, encoding: "utf8" },
      );
      assert.equal(duplicate.status, 1);
      assert(duplicate.stderr.includes(worktree));
      const consultation = cli(aligndev, repo, "guide", "consultation");
      assert.match(consultation, /Do not create a worktree merely to answer a question/);
      const working = cli(aligndev, repo, "guide", "project-workspace-setup");
      assert.match(working, /for a status request, end the turn/);
      const beforeStatus = git("worktree", "list", "--porcelain");
      assert.equal(git("branch", "--list", "side-2/*"), "");
      cli(alignfirst, repo, "workspace", "list", "--json");
      assert.equal(
        git("worktree", "list", "--porcelain"),
        beforeStatus,
        "no-branch status is read-only",
      );
      assert.equal(git("status", "--porcelain"), "");
      const registryBefore =
        mode === "shared"
          ? undefined
          : readFileSync(join(home, ".alignfirst/companions/registry.json"), "utf8");
      cli(alignfirst, repo, "workspace", "remove", worktree, "--json");
      assert.equal(existsSync(worktree), false);
      assert.equal(readFileSync(join(repo, ".local/keep.txt"), "utf8"), "shared local data\n");
      assert(existsSync(join(plans, "side-1/A1-request.md")));
      assert.equal(git("branch", "--list", "side-1/label"), "side-1/label");
      if (mode !== "shared") {
        assert.equal(readFileSync(join(plans, "keep.md"), "utf8"), "existing companion data\n");
        assert.equal(
          readFileSync(join(home, ".alignfirst/companions/registry.json"), "utf8"),
          registryBefore,
        );
        assert.equal(existsSync(join(plans, "old-history.md")), false);
      }
      if (mode === "tracked")
        assert.equal(readFileSync(join(repo, ".plans/old-history.md"), "utf8"), OLD_HISTORY);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
