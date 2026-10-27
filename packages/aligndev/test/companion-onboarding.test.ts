import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAlignfirst } from "../src/alignfirst-cli.js";
import { resolveCommandForms } from "../src/command-form.js";
import { PLATFORMS, type Platform } from "../src/config.js";
import type { CompanionReport, ProjectReport } from "../src/project/layout.js";
import { ALIGNFIRST_BIN, writeRegistry, writeSettings } from "./helpers.js";
import {
  execGit,
  type Fixture,
  makeFixture,
  makeRepository,
  runAligndev,
  useProjectFixtures,
} from "./project/fixtures.js";

const COMPANION_SETUP = new URL(
  "../../../skills/alignfirst-setup-guide/references/companion-setup.md",
  import.meta.url,
);
const REGISTRATION_STATES = ["missing", "profileOnly", "registered"] as const;
const NPX_ENV = {
  npm_config_user_agent: "npm/11.19.0 node/v26.8.1 linux x64",
  npm_command: "exec",
  npm_lifecycle_event: "npx",
};

interface OnboardingReport extends ProjectReport {
  companion: OnboardingCompanion | null;
}

interface OnboardingCompanion extends CompanionReport {
  key: string;
}

interface Registry {
  projects: Record<string, RegistryEntry>;
  [key: string]: unknown;
}

interface RegistryEntry {
  dir?: string;
  items?: Record<string, unknown>;
  [key: string]: unknown;
}

useProjectFixtures();

describe("explicit companion-only onboarding", () => {
  it.each([false, true])(
    "renders registration before the conditional plans gate and delegation (npx=%s)",
    async (viaNpx) => {
      const fixture = makeFixture();
      writeSettings(fixture.home, { platform: "openclaw", projectsRoot: fixture.root });
      const env = viaNpx ? NPX_ENV : {};
      const forms = resolveCommandForms(env);
      const result = await runAligndev(
        fixture,
        ["guide", "--channel", "slack", "project-lifecycle"],
        { env },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("{{");
      const route = result.stdout
        .split("### Prepare through the companion\n")[1]
        .split("\n## Remove a project")[0];
      const register = route.indexOf(`${forms.alignfirst} companion register`);
      const select = route.indexOf(`${forms.aligndev} guide --channel slack work-files-setup`);
      const verify = route.indexOf(`${forms.alignfirst} config --json`);
      const delegate = route.indexOf(`${forms.aligndev} guide --channel slack code`);
      expect(register).toBeGreaterThan(0);
      expect(select).toBeGreaterThan(register);
      expect(verify).toBeGreaterThan(select);
      expect(delegate).toBeGreaterThan(verify);
      expect(route).toContain("even when existing project plans are usable");
      expect(route).toContain("starting at section 3");
      expect(route).toContain("every item to write resolve inside `companion.dir`");
      expect(route).toContain("Missing `.alignfirst.json` and `DEVELOPERS.md`");
      expect(route).toContain("stop and resolve that selection with the user");
      expect(route).toContain("without copying them");
    },
  );

  it.each(PLATFORMS)(
    "renders the explicit entry into the shared selection recipe for %s",
    async (platform) => {
      const fixture = makeFixture();
      const repo = makeUntouchedProject(fixture);
      writeSettings(fixture.home, { platform, projectsRoot: fixture.root });
      const result = await runAligndev(fixture, workFilesSetupArgs(platform), { cwd: repo });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("{{");
      const explicitEntry = result.stdout.indexOf("For explicit companion-only onboarding");
      const readinessGate = result.stdout.indexOf("## 1. Check the effective work files");
      expect(explicitEntry).toBeGreaterThan(0);
      expect(explicitEntry).toBeLessThan(readinessGate);
      expect(result.stdout).toContain("start at section 3 under the onboarding authorization");
      expect(result.stdout).toContain("even when existing project plans are usable");
      expect(result.stdout).toContain(
        "Usable, non-project-tracked effective plans need no preparation",
      );
      expect(result.stdout).toContain("alignfirst companion register");
      expect(result.stdout).toContain('setting `items[".plans"]` to `"companion"`');
      expect(result.stdout).toContain(
        "Preserve all other fields, item settings, profile selections",
      );
    },
  );

  it("keeps companion declaration and explicit plans selection in the setup skill", () => {
    const reference = readFileSync(COMPANION_SETUP, "utf8");
    const assistant = reference.split("## For an Assistant\n")[1].split("\n## Select a Profile")[0];
    expect(assistant).toContain("**Companion (step 2):** always register and verify the companion");
    expect(assistant).toContain("independently of plans readiness");
    expect(assistant).toContain("starting at section 3 under that authorization");
    expect(assistant).toContain("even when project plans are usable");
    expect(assistant).not.toContain("Usable plans need no preparation");
    expect(reference).toContain('`projects[companion.key].items[".plans"]` to `"companion"`');
    expect(reference).toContain(
      "Preserve all other registry fields, item settings, profile selections",
    );
    expect(reference).toContain("every item to write resolve inside `companion.dir`");
    expect(reference).toContain("do not copy, merge, migrate, archive, or delete them");
  });

  it.each(REGISTRATION_STATES)(
    "follows the authorized recipe with usable ignored project plans (%s registration)",
    async (state) => {
      const fixture = makeFixture();
      const repo = makeUntouchedProject(fixture);
      const key = repo;
      const entry: RegistryEntry = {
        aligndev: { profile: "kept-profile", futureProfileField: { keep: true } },
        futureEntryField: ["keep"],
        ...(state === "registered"
          ? {
              dir: "existing",
              items: { ".plans": "project", docs: "project", _aligndev: "companion" },
            }
          : {}),
      };
      const registry: Registry = {
        futureRootField: { keep: true },
        projects: {
          "~/unrelated": { dir: "unrelated", futureEntryField: "keep" },
          ...(state === "missing" ? {} : { [key]: entry }),
        },
      };
      if (state !== "missing") writeRegistry(fixture.home, registry);
      const existingCompanion = join(fixture.home, ".alignfirst", "companions", "existing");
      if (state === "registered") {
        mkdirSync(join(existingCompanion, ".plans", "side-8"), { recursive: true });
        writeFileSync(
          join(existingCompanion, ".plans", "side-8", "A1-request.md"),
          "keep companion history\n",
        );
      }
      const before = readReport(fixture, repo);
      expect(before.companion === null).toBe(state !== "registered");
      expect(before.config).toBeNull();
      expect(before.locations["DEVELOPERS.md"]).toEqual({
        path: join(state === "registered" ? existingCompanion : repo, "DEVELOPERS.md"),
        in: state === "registered" ? "companion" : "project",
        exists: false,
      });
      expect(before.locations[".plans"].path).toBe(join(repo, ".plans"));
      expect(execGit(repo, "ls-files", "--", ".plans")).toBe("");
      expect(execGit(repo, "check-ignore", ".plans/side-7/A1-request.md")).toBe(
        ".plans/side-7/A1-request.md",
      );
      runFirst(fixture, repo, ["plans", "check"]);
      const filesBefore = snapshot(repo);
      const excludeBefore = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
      const worktreesBefore = execGit(repo, "worktree", "list", "--porcelain");
      const headBefore = execGit(repo, "rev-parse", "HEAD");

      // Execute the explicit onboarding entry, rather than the readiness gate's early return.
      runFirst(fixture, repo, ["companion", "register"]);
      const registered = readReport(fixture, repo);
      if (registered.companion === null) throw new Error("Onboarding did not register a companion");
      const { dir, key: reportedKey } = registered.companion;
      expect(readReport(fixture, repo).locations[".plans"].path).toBe(join(repo, ".plans"));
      const registryPath = join(fixture.home, ".alignfirst", "companions", "registry.json");
      const registeredRegistry: Registry = JSON.parse(readFileSync(registryPath, "utf8"));
      const registrationBytes = readFileSync(registryPath, "utf8");
      runFirst(fixture, repo, ["companion", "register"]);
      expect(readFileSync(registryPath, "utf8")).toBe(registrationBytes);
      if (state !== "missing") {
        expect(reportedKey).toBe(key);
        expect(registeredRegistry).toEqual({
          ...registry,
          projects: {
            ...registry.projects,
            [key]: { ...entry, dir: entry.dir ?? registeredRegistry.projects[key].dir },
          },
        });
      }
      const selectedEntry = registeredRegistry.projects[reportedKey];
      selectedEntry.items = { ...selectedEntry.items, ".plans": "companion" };
      writeRegistry(fixture.home, registeredRegistry);
      const selected = readReport(fixture, repo);
      for (const item of [".plans", "alignfirst", "DEVELOPERS.md"] as const) {
        expect(selected.locations[item].in, item).toBe("companion");
        expect(selected.locations[item].path, item).toBe(
          join(dir, item === "alignfirst" ? "alignfirst.json" : item),
        );
      }
      mkdirSync(selected.locations[".plans"].path, { recursive: true });
      runFirst(fixture, repo, ["plans", "check"]);
      expect(existsSync(join(dir, ".plans", "side-7"))).toBe(false);
      if (state === "registered") {
        expect(dir).toBe(existingCompanion);
        expect(readFileSync(join(dir, ".plans", "side-8", "A1-request.md"), "utf8")).toBe(
          "keep companion history\n",
        );
      } else {
        expect(readdirSync(join(dir, ".plans"))).toEqual([]);
      }
      writeFileSync(selected.locations.alignfirst.path, '{"schemaVersion":1}\n');
      writeFileSync(selected.locations["DEVELOPERS.md"].path, "# Developer guide\n");
      const prepared = readReport(fixture, repo);
      expect(prepared.source).toBe("companion");
      expect(prepared.locations["DEVELOPERS.md"].exists).toBe(true);
      expect(prepared.aligndev).toEqual(state === "missing" ? null : { profile: "kept-profile" });
      const finalRegistry: Registry = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(finalRegistry).toEqual(registeredRegistry);
      expect(snapshot(repo)).toEqual(filesBefore);
      expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
      expect(execGit(repo, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
      expect(execGit(repo, "rev-parse", "HEAD")).toBe(headBefore);
      expect(execGit(repo, "branch", "--show-current")).toBe("main");
      expect(execGit(repo, "status", "--porcelain")).toBe("");
    },
  );
});

function makeUntouchedProject(fixture: Fixture): string {
  const repo = makeRepository(fixture.root, "app");
  rmSync(join(repo, "README.md"));
  writeFileSync(join(repo, ".gitignore"), "/.plans/\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "api.md"), "# Existing documentation\n");
  execGit(repo, "add", "-A");
  execGit(repo, "commit", "--quiet", "-m", "fixture without onboarding files");
  mkdirSync(join(repo, ".plans", "side-7"), { recursive: true });
  writeFileSync(join(repo, ".plans", "side-7", "A1-request.md"), "keep project history\n");
  return repo;
}

function readReport(fixture: Fixture, repo: string): OnboardingReport {
  return JSON.parse(runFirst(fixture, repo, ["config", "--json"]));
}

function runFirst(fixture: Fixture, repo: string, args: string[]): string {
  const result = runAlignfirst([process.execPath, ALIGNFIRST_BIN], args, repo, {
    ...process.env,
    HOME: fixture.home,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files[`${entry.name}/`] = "directory";
      for (const [child, bytes] of Object.entries(snapshot(path))) {
        files[`${entry.name}/${child}`] = bytes;
      }
    } else {
      files[entry.name] = readFileSync(path).toString("hex");
    }
  }
  return files;
}

function workFilesSetupArgs(platform: Platform): string[] {
  return platform === "openclaw"
    ? ["guide", "--channel", "slack", "work-files-setup"]
    : ["guide", "work-files-setup"];
}
