import { describe, expect, it } from "vitest";

import { computeWorktreePath } from "../src/worktree.js";

describe("computeWorktreePath", () => {
  it("places the worktree as a sibling of the main worktree", () => {
    expect(computeWorktreePath("/home/dev/myrepo", "feat/42")).toBe("/home/dev/myrepo-feat-42");
  });

  it("sanitizes slashes to dashes", () => {
    expect(computeWorktreePath("/x/myrepo", "user/topic/sub")).toBe("/x/myrepo-user-topic-sub");
  });

  it("preserves the repository directory name", () => {
    expect(computeWorktreePath("/a/b/c/cool-repo", "main")).toBe("/a/b/c/cool-repo-main");
  });
});
