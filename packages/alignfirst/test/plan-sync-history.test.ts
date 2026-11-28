import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { findStoppedRebase } from "../src/plans/rebase.js";
import { git, runMain } from "./helpers.js";
import {
  commitLocal,
  makeSyncFixture,
  publishOther,
  remoteContent,
  removeSyncFixtures,
  write,
} from "./plan-sync-fixture.js";

afterEach(removeSyncFixtures);

it("consolidates repeated sync edits and preserves the final local session contents", async () => {
  const path = "product-plans/78/_aligndev/x.md";
  const fixture = await makeSyncFixture({ [path]: "base\n" });
  for (const content of ["first\n", "second\n", "final local\n"]) {
    write(fixture.clone, path, content);
    commitLocal(fixture, "sync");
  }
  write(fixture.other, path, "remote\n");
  publishOther(fixture);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe("remote\n");
  expect(remoteContent(fixture, "product-plans/78/_aligndev/x-local-2.md")).toBe("final local\n");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it("consolidates sync-only history into one commit with the same tree", async () => {
  const fixture = await makeSyncFixture();
  const base = git(fixture.clone, "rev-parse", "@{u}");
  for (const content of ["first", "second", "third"]) {
    write(fixture.clone, "note.md", content);
    commitLocal(fixture, "sync");
  }
  const tree = git(fixture.clone, "rev-parse", "HEAD^{tree}");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
  expect(git(fixture.clone, "rev-parse", "HEAD^{tree}")).toBe(tree);
});

it("keeps a mixed manual history unchanged", async () => {
  const fixture = await makeSyncFixture();
  for (const [index, message] of ["sync", "manual change", "sync"].entries()) {
    write(fixture.clone, "note.md", `${index}: ${message}`);
    commitLocal(fixture, message);
  }
  const head = git(fixture.clone, "rev-parse", "HEAD");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(head);
});

it("drops a net-empty sync history back to the upstream", async () => {
  const fixture = await makeSyncFixture();
  const base = git(fixture.clone, "rev-parse", "@{u}");
  write(fixture.clone, "note.md", "temporary");
  commitLocal(fixture, "sync");
  rmSync(join(fixture.clone, "note.md"));
  commitLocal(fixture, "sync");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(base);
});

it("keeps a running log untracked until completion", async () => {
  const fixture = await makeSyncFixture();
  const path = "product-plans/78/_aligndev/run.running.md";
  write(fixture.clone, path, "---\nstatus: running\n---\ntranscript\n");
  write(fixture.clone, "note.md", "other document");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(path);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(path);
  expect(git(fixture.clone, "ls-files", "--cached")).not.toContain(path);
  const completed = path.replace(".running.md", ".md");
  write(fixture.clone, completed, "---\nstatus: succeeded\n---\nfinished\n");
  rmSync(join(fixture.clone, path));
  expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);
  expect(remoteContent(fixture, completed)).toBe("---\nstatus: succeeded\n---\nfinished\n");
});

it("keeps an archived running log local too", async () => {
  const fixture = await makeSyncFixture();
  const path = "product-plans/_archives/78/_aligndev/run.running.md";
  write(fixture.clone, path, "---\nstatus: running\n---\n");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(path);
});

it("keeps a running log local through automatic conflict resolution", async () => {
  const fixture = await makeSyncFixture({ "product-plans/80/spec.md": "base\n" });
  const running = "product-plans/80/_aligndev/run.running.md";
  const content = "---\nstatus: running\n---\ntranscript\n";
  write(fixture.clone, running, content);
  write(fixture.clone, "product-plans/80/spec.md", "local\n");
  write(fixture.other, "product-plans/80/spec.md", "remote\n");
  publishOther(fixture);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(running);
  expect(readFileSync(join(fixture.clone, running), "utf8")).toBe(content);
  expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(running);
});

it("leaves pending sync-message merges intact before Git's rebase", async () => {
  const fixture = await makeSyncFixture();
  git(fixture.clone, "checkout", "--quiet", "-b", "side");
  write(fixture.clone, "side.md", "side\n");
  commitLocal(fixture, "sync");
  git(fixture.clone, "checkout", "--quiet", "main");
  write(fixture.clone, "main.md", "main\n");
  commitLocal(fixture, "sync");
  git(fixture.clone, "merge", "--quiet", "--no-ff", "-m", "sync", "side");
  const head = git(fixture.clone, "rev-parse", "HEAD");
  const beforeRebase = join(fixture.root, "before-rebase");
  const hook = join(fixture.clone, ".git/hooks/pre-rebase");
  writeFileSync(hook, `#!/bin/sh\ngit rev-parse HEAD > '${beforeRebase}'\n`);
  chmodSync(hook, 0o755);
  write(fixture.other, "remote.md", "remote\n");
  publishOther(fixture);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(beforeRebase, "utf8").trim()).toBe(head);
});
