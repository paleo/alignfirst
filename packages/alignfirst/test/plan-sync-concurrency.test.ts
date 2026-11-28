import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { findStoppedRebase, resolveStoppedRebase } from "../src/plans/rebase.js";
import { git, makeSink, runMain } from "./helpers.js";
import {
  commitLocal,
  makeSyncFixture,
  publishOther,
  remoteContent,
  removeSyncFixtures,
  write,
} from "./plan-sync-fixture.js";

const RETRY_BUDGET_MS = 100;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeSyncFixtures();
});

it("does not retry an ordinary push rejection and releases the lock", async () => {
  const fixture = await makeSyncFixture();
  const hook = join(fixture.remote, "hooks/pre-receive");
  const attempts = join(fixture.root, "push-attempts");
  writeFileSync(hook, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  write(fixture.clone, "note.md", "local\n");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code).toBe(1);
  expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
  expect(existsSync(join(fixture.clone, ".git/alignfirst-sync.lock"))).toBe(false);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it("reports a live lock when the retry budget expires", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fixture = await makeSyncFixture();
  const path = join(fixture.clone, ".git/alignfirst-sync.lock");
  mkdirSync(path);
  writeFileSync(join(path, "pid"), String(process.pid));
  const started = Date.now();
  const result = await runMain(["sync"], {
    cwd: fixture.product,
    env: { ALIGNFIRST_SYNC_RETRY_MS: String(RETRY_BUDGET_MS) },
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(path);
  expect(result.stderr).toContain(String(process.pid));
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(RETRY_BUDGET_MS);
  expect(elapsed).toBeLessThan(5000);
  expect(existsSync(path)).toBe(true);
}, 10_000);

it("retries after the remote advances just before the first push", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fixture = await makeSyncFixture();
  write(fixture.clone, "local.md", "local\n");
  write(fixture.other, "remote.md", "remote\n");
  git(fixture.other, "add", "-A");
  git(fixture.other, "commit", "--quiet", "-m", "remote race");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(fixture.root, "bin");
  const marker = join(fixture.root, "pushed");
  mkdirSync(bin);
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase " $* " in *" push "*)\n  if [ ! -f '${marker}' ]; then\n    touch '${marker}'\n    '${realGit}' -C '${fixture.other}' push --quiet || exit $?\n  fi\nesac\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(marker)).toBe(true);
  expect(remoteContent(fixture, "local.md")).toBe("local\n");
  expect(remoteContent(fixture, "remote.md")).toBe("remote\n");
  expect(git(fixture.remote, "log", "--format=%s")).toContain("remote race");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it.each([false, true])(
  "keeps a write that lands before the rebase starts (autoStash=%s)",
  async (autoStash) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const path = "product-plans/80/f.md";
    const fixture = await makeSyncFixture({ [path]: "base\n" });
    git(fixture.clone, "config", "rebase.autoStash", String(autoStash));
    write(fixture.other, "remote.md", "remote\n");
    publishOther(fixture);
    write(fixture.clone, "local.md", "local\n");
    const marker = join(fixture.root, "written");
    const hook = join(fixture.clone, ".git/hooks/pre-rebase");
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -f '${marker}' ]; then\n  touch '${marker}'\n  printf 'concurrent\\n' > '${path}'\nfi\n`,
    );
    chmodSync(hook, 0o755);

    const result = await runMain(["sync"], { cwd: fixture.product });

    expect(result.code, result.stderr).toBe(0);
    expect(remoteContent(fixture, path)).toBe("concurrent\n");
    expect(remoteContent(fixture, "local.md")).toBe("local\n");
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
    expect(git(fixture.clone, "stash", "list")).toBe("");
  },
);

it("keeps a write that lands during the rebase", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const path = "product-plans/80/f.md";
  const fixture = await makeSyncFixture({ [path]: "base\n" });
  write(fixture.other, "remote.md", "remote\n");
  publishOther(fixture);
  write(fixture.clone, path, "local\n");
  write(fixture.clone, "other.md", "other local\n");
  const marker = join(fixture.root, "written");
  const hook = join(fixture.clone, ".git/hooks/post-checkout");
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ ! -f '${marker}' ]; then\n  touch '${marker}'\n  printf 'concurrent\\n' > '${path}'\nfi\n`,
  );
  chmodSync(hook, 0o755);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe("concurrent\n");
  expect(remoteContent(fixture, "other.md")).toBe("other local\n");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "stash", "list")).toBe("");
});

it("does not skip a stopped commit while the working tree is dirty", async () => {
  const path = "product-plans/80/f.md";
  const fixture = await makeSyncFixture({ [path]: "base\n" });
  write(fixture.other, "remote.md", "remote\n");
  publishOther(fixture);
  write(fixture.clone, path, "local\n");
  write(fixture.clone, "other.md", "other local\n");
  commitLocal(fixture, "sync");
  git(fixture.clone, "fetch", "--quiet");
  const hook = join(fixture.clone, ".git/hooks/post-checkout");
  writeFileSync(hook, `#!/bin/sh\nprintf 'concurrent\\n' > '${path}'\n`);
  chmodSync(hook, 0o755);
  expect(() => git(fixture.clone, "-c", "rebase.autoStash=false", "rebase", "@{u}")).toThrow();
  expect(findStoppedRebase(fixture.clone)?.conflictedFiles).toEqual([]);

  await expect(
    resolveStoppedRebase({ stdout: makeSink(), stderr: makeSink() }, fixture.clone),
  ).rejects.toThrow();

  expect(readFileSync(join(fixture.clone, path), "utf8")).toBe("concurrent\n");
  expect(findStoppedRebase(fixture.clone)).toBeDefined();
});

it("gives up when work files keep changing", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const path = "product-plans/80/f.md";
  const fixture = await makeSyncFixture({ [path]: "base\n" });
  write(fixture.other, "remote.md", "remote\n");
  publishOther(fixture);
  write(fixture.clone, "local.md", "local\n");
  const hook = join(fixture.clone, ".git/hooks/pre-rebase");
  writeFileSync(hook, `#!/bin/sh\nprintf 'concurrent\\n' >> '${path}'\n`);
  chmodSync(hook, 0o755);

  const result = await runMain(["sync"], {
    cwd: fixture.product,
    env: { ALIGNFIRST_SYNC_RETRY_MS: String(RETRY_BUDGET_MS) },
  });

  expect(result.code).toBe(1);
  expect(existsSync(join(fixture.clone, ".git/alignfirst-sync.lock"))).toBe(false);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  const content = readFileSync(join(fixture.clone, path), "utf8");
  expect(content).toMatch(/^base\n(?:concurrent\n)+$/);
  expect(git(fixture.clone, "diff", "--", path)).toContain("+concurrent");
  expect(Number(git(fixture.clone, "rev-list", "--count", "@{u}..HEAD"))).toBeGreaterThanOrEqual(1);
});

it("rejects an invalid retry budget before any work-file effect", async () => {
  const fixture = await makeSyncFixture();
  const head = git(fixture.clone, "rev-parse", "HEAD");
  write(fixture.clone, "note.md", "not published\n");
  const result = await runMain(["sync"], {
    cwd: fixture.product,
    env: { ALIGNFIRST_SYNC_RETRY_MS: "-1" },
  });
  expect(result.code).toBe(1);
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(head);
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(fixture.clone, "note.md"), "utf8")).toBe("not published\n");
});
