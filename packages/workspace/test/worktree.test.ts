import { describe, expect, it } from "vitest";

import { computeWorktreePath, defaultWorktreeDirName } from "../src/worktree.js";

describe("computeWorktreePath", () => {
  it("places the worktree as a sibling of the main worktree", () => {
    expect(computeWorktreePath("/home/dev/myrepo", "feat/42")).toBe("/home/dev/myrepo-feat-42");
  });

  it("honors a custom worktreeDirName", () => {
    expect(
      computeWorktreePath("/x/myrepo", "feat/42", ({ branch }) => `wt-${branch.replace("/", "_")}`),
    ).toBe("/x/wt-feat_42");
  });
});

describe("defaultWorktreeDirName", () => {
  it.each([
    ["feat/ABC-123-something-else", "myrepo-feat-ABC-123"],
    ["feat/123-something", "myrepo-feat-123"],
    ["ABC-123-extra", "myrepo-ABC-123"],
    ["feat/just-words", "myrepo-feat-just-words"],
    ["feat/sub/ABC-123-extra", "myrepo-feat-sub-ABC-123"],
    ["feat/this-is-a-very-long-branch-name", "myrepo-feat-this-is-a-very-lo"],
    // The 22-char cap leaves "long-branch-name-here-"; the trailing dash goes.
    ["long-branch-name-here-x", "myrepo-long-branch-name-here"],
  ])("names branch %s as %s", (branch, expected) => {
    expect(defaultWorktreeDirName({ branch, repoName: "myrepo" })).toBe(expected);
  });
});
