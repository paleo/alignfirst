import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAlignfirst } from "../src/alignfirst-cli.js";
import type { CompanionReport, ProjectReport } from "../src/project/layout.js";
import { ALIGNFIRST_BIN, writeRegistry } from "./helpers.js";
import {
  execGit,
  type Fixture,
  makeFixture,
  makeRepository,
  useProjectFixtures,
} from "./project/fixtures.js";

const REGISTRATION_STATES = ["missing", "profileOnly", "registered"] as const;

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
      expect(before.locations.assistantInstructionsFile).toBeNull();
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
      for (const item of [".plans", "alignfirst"] as const) {
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
      writeFileSync(
        selected.locations.alignfirst.path,
        '{"schemaVersion":1,"assistantInstructionsFile":"handbook/workflow.md"}\n',
      );
      const instructions = readReport(fixture, repo).locations.assistantInstructionsFile;
      if (instructions === null) throw new Error("Missing configured assistant instructions");
      expect(instructions).toMatchObject({
        in: "companion",
        path: join(dir, "handbook", "workflow.md"),
        exists: false,
      });
      mkdirSync(join(dir, "handbook"));
      writeFileSync(instructions.path, "# Assistant guide\n\nSee [details](./details.md).\n");
      const assistantInstructions = runFirst(fixture, repo, ["assistant-instructions"]);
      expect(assistantInstructions).toContain(instructions.path);
      expect(assistantInstructions).toContain(
        "# Assistant guide\n\nSee [details](./details.md).\n",
      );
      const prepared = readReport(fixture, repo);
      expect(prepared.source).toBe("companion");
      expect(prepared.locations.assistantInstructionsFile?.exists).toBe(true);
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
