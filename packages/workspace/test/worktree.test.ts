import { describe, expect, it } from "vitest";

import { computeWorktreePath, defaultWorktreeDirName } from "../src/worktree.js";

describe("computeWorktreePath", () => {
  it("places the worktree as a sibling of the main worktree", () => {
    expect(computeWorktreePath("/home/dev/myrepo", "feat/42")).toBe("/home/dev/myrepo-feat-42");
  });

  it("preserves the repository directory name", () => {
    expect(computeWorktreePath("/a/b/c/cool-repo", "main")).toBe("/a/b/c/cool-repo-main");
  });

  it("honors a custom worktreeDirName", () => {
    expect(
      computeWorktreePath("/x/myrepo", "feat/42", ({ branch }) => `wt-${branch.replace("/", "_")}`),
    ).toBe("/x/wt-feat_42");
  });
});

describe("defaultWorktreeDirName", () => {
  const repoName = "myrepo";

  it("strips the suffix after `<letters>-<numbers>`", () => {
    expect(defaultWorktreeDirName({ branch: "feat/ABC-123-something-else", repoName })).toBe(
      "myrepo-feat-ABC-123",
    );
  });

  it("strips the suffix after just numbers", () => {
    expect(defaultWorktreeDirName({ branch: "feat/123-something", repoName })).toBe(
      "myrepo-feat-123",
    );
  });

  it("matches the pattern when there is no `/`", () => {
    expect(defaultWorktreeDirName({ branch: "ABC-123-extra", repoName })).toBe("myrepo-ABC-123");
  });

  it("falls back to the full sanitized branch when no pattern matches", () => {
    expect(defaultWorktreeDirName({ branch: "feat/just-words", repoName })).toBe(
      "myrepo-feat-just-words",
    );
  });

  it("sanitizes nested slashes", () => {
    expect(defaultWorktreeDirName({ branch: "feat/sub/ABC-123-extra", repoName })).toBe(
      "myrepo-feat-sub-ABC-123",
    );
  });

  it("caps the slug at 22 chars", () => {
    expect(
      defaultWorktreeDirName({ branch: "feat/this-is-a-very-long-branch-name", repoName }),
    ).toBe("myrepo-feat-this-is-a-very-lo");
  });

  it("strips trailing dashes after truncation", () => {
    // sanitized: "long-branch-name-here-x" (23 chars); slice(0,22) = "long-branch-name-here-" → trim → "long-branch-name-here"
    expect(defaultWorktreeDirName({ branch: "long-branch-name-here-x", repoName })).toBe(
      "myrepo-long-branch-name-here",
    );
  });

  it("leaves short branches untouched", () => {
    expect(defaultWorktreeDirName({ branch: "main", repoName })).toBe("myrepo-main");
  });
});
