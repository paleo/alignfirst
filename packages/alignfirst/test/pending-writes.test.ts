import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { capturePendingWrites, restorePendingWrites } from "../src/plans/pending-writes.js";
import { configureGit, git, initRepository, makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("restores exact bytes, unusual paths and deletions while leaving untracked files alone", () => {
  const dir = makeFixture();
  const path = " leading\n[spec]*.md";
  writeFileSync(join(dir, path), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "tracked document");
  const content = Buffer.from([0x00, 0xff, 0x0a, 0x80]);
  writeFileSync(join(dir, path), content);
  rmSync(join(dir, "README.md"));
  writeFileSync(join(dir, "untracked.md"), "leave alone\n");

  const writes = capturePendingWrites(dir);
  expect(writes).toHaveLength(2);
  expect(writes).toContainEqual({ path, content });
  expect(writes).toContainEqual({ path: "README.md", content: undefined });
  git(dir, "reset", "--hard", "HEAD");
  restorePendingWrites(dir, writes);

  expect(readFileSync(join(dir, path))).toEqual(content);
  expect(existsSync(join(dir, "README.md"))).toBe(false);
  expect(readFileSync(join(dir, "untracked.md"), "utf8")).toBe("leave alone\n");
});

it("recreates a tracked file whose parent disappears during an abort", () => {
  const dir = makeFixture();
  mkdirSync(join(dir, "ticket"));
  writeFileSync(join(dir, "ticket/spec.md"), "local\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "local document");
  writeFileSync(join(dir, "ticket/spec.md"), "concurrent\n");
  const writes = capturePendingWrites(dir);
  git(dir, "reset", "--hard", "HEAD~");

  restorePendingWrites(dir, writes);

  expect(readFileSync(join(dir, "ticket/spec.md"), "utf8")).toBe("concurrent\n");
});

it("refuses an index changed behind the CLI's back", () => {
  const dir = makeFixture();
  writeFileSync(join(dir, "README.md"), "staged\n");
  git(dir, "add", "-A");
  expect(() => capturePendingWrites(dir)).toThrow("index changed during synchronization");
  expect(git(dir, "diff", "--cached")).toContain("+staged");
});

it("refuses to read a pending symlink", () => {
  const dir = makeFixture();
  rmSync(join(dir, "README.md"));
  symlinkSync("gitconfig", join(dir, "README.md"));
  expect(() => capturePendingWrites(dir)).toThrow("Cannot automatically replace README.md");
});

it("refuses to restore through a symlink in the directory chain", () => {
  const dir = makeFixture();
  const outside = makeTempDir("alignfirst-pending-outside-");
  dirs.push(outside);
  symlinkSync(outside, join(dir, "ticket"));

  expect(() =>
    restorePendingWrites(dir, [{ path: "ticket/spec.md", content: Buffer.from("pending\n") }]),
  ).toThrow("Cannot automatically write through ticket");
  expect(existsSync(join(outside, "spec.md"))).toBe(false);
});

function makeFixture(): string {
  const dir = makeTempDir("alignfirst-pending-");
  dirs.push(dir);
  configureGit(dir);
  initRepository(dir);
  return dir;
}
