import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readLinkedGitCommonDir } from "../../src/code/linked-worktree.js";
import {
  addWorktree,
  makeFixture,
  makeRepository,
  useProjectFixtures,
} from "../project/fixtures.js";

useProjectFixtures();

describe("readLinkedGitCommonDir", () => {
  it("returns the main checkout's git directory from a linked worktree", () => {
    const fixture = makeFixture();
    const main = makeRepository(fixture.root, "app");
    const linked = join(fixture.root, "app-feature");
    addWorktree(main, linked, "feature");
    expect(readLinkedGitCommonDir({ cwd: linked, env: process.env })).toBe(join(main, ".git"));
  });

  it("returns nothing in a main checkout", () => {
    const main = makeRepository(makeFixture().root, "app");
    expect(readLinkedGitCommonDir({ cwd: main, env: process.env })).toBeUndefined();
  });

  it("returns nothing outside a git repository", () => {
    const fixture = makeFixture();
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: fixture.base };
    expect(readLinkedGitCommonDir({ cwd: fixture.root, env })).toBeUndefined();
  });
});
