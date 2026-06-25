import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type PatchContext, resolveConfigSource } from "../src/workspace.js";

const ctx: PatchContext = {
  slot: 8110,
  ports: { server: 8110 },
  mainWorktree: "/repo/main",
  currentWorktree: "/repo/feat",
};

describe("resolveConfigSource", () => {
  it("reads a `mainWorktree` source at the entry's path in the main worktree", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "mainWorktree" } },
      ctx,
    );
    expect(source).toEqual({ path: join("/repo/main", ".env") });
  });

  it("reads a `newWorktree` source at the template path in the current worktree", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "newWorktree", path: ".env.example" } },
      ctx,
    );
    expect(source).toEqual({ path: join("/repo/feat", ".env.example") });
  });

  it("returns a `content` string verbatim", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("resolves a synchronous `content` function", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: () => "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("awaits an asynchronous `content` function", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: async () => "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });
});
