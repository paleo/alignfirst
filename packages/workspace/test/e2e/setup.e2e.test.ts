import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SlotEntry } from "../../src/slots.js";
import { createFixtureRepo, type FixtureRepo, packageRoot, readSlots, runCli } from "./fixture.js";

// Each scenario spawns the CLI plus a detached finalize child — give them room.
const TEST_TIMEOUT_MS = 60_000;

const createdRoots: string[] = [];

beforeAll(() => {
  buildIfStale();
}, 120_000);

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace setup (e2e)", () => {
  it(
    "blocking setup reaches READY and prints no background message",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-x"]);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output).toContain("… ready");
      expect(output).not.toContain("Setup continuing in background.");
      expect(existsSync(join(repo, "..", "fixrepo-feat-x", "finalized.txt"))).toBe(true);
      expect(slotFor(repo, "fixrepo-feat-x").status).toBe("ready");
      const log = setupLog(repo, "fixrepo-feat-x");
      expect(log).toContain("PROGRESS: step-one");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "detached setup returns before READY, then `wait` finalizes",
    () => {
      const { repo } = fixture();
      const detached = runCli(repo, ["setup", "-c", "feat-y", "-d"]);
      const detachedOut = detached.stdout + detached.stderr;

      expect(detached.status).toBe(0);
      expect(detachedOut).toContain("Setup continuing in background.");
      expect(detachedOut).toContain("Join it with");

      const waited = runCli(repo, ["wait", "fixrepo-feat-y"]);
      expect(waited.status).toBe(0);
      expect(existsSync(join(repo, "..", "fixrepo-feat-y", "finalized.txt"))).toBe(true);
      expect(slotFor(repo, "fixrepo-feat-y").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "failing finalize exits 1 with the FAILED reason",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-z"], { E2E_FINALIZE_FAIL: "1" });
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(1);
      expect(output).toContain("FAILED");
      expect(output).toContain("e2e boom");
      expect(slotFor(repo, "fixrepo-feat-z").status).toBe("failed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "detached --go prints the cd hint immediately on non-TTY",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-g", "-d", "--go"]);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output).toContain("Now run: cd");
      expect(output).toContain("Setup continuing in background.");
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(): FixtureRepo {
  const fx = createFixtureRepo();
  createdRoots.push(fx.root);
  return fx;
}

function slotFor(repo: string, worktreeDir: string): SlotEntry {
  const entry = Object.values(readSlots(repo).slots).find(
    (e) => basename(e.worktree) === worktreeDir,
  );
  if (!entry) throw new Error(`No slot registered for ${worktreeDir}`);
  return entry;
}

function setupLog(repo: string, worktreeDir: string): string {
  return readFileSync(join(repo, "..", worktreeDir, ".wt", "logs", "workspace-setup.log"), "utf-8");
}

// Rebuild `dist/` only when it is missing or older than the newest `src/` file, so a second `vitest`
// run in a row skips the rebuild.
function buildIfStale(): void {
  const distIndex = join(packageRoot, "dist", "index.js");
  if (existsSync(distIndex) && statSync(distIndex).mtimeMs >= newestSrcMtime()) {
    console.log("[e2e] dist is up to date; skipping build.");
    return;
  }
  console.log("[e2e] building @paleo/workspace…");
  execFileSync("npm", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
}

function newestSrcMtime(): number {
  const srcDir = join(packageRoot, "src");
  let newest = 0;
  for (const rel of readdirSync(srcDir, { recursive: true })) {
    const full = join(srcDir, rel.toString());
    const stat = statSync(full);
    if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}
