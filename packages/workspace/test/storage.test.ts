import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { resolveWorkspaceStorage } from "../src/storage.js";

it("addresses canonical targets independently without creating storage or truncating their identity", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-storage-"));
  try {
    const main = join(root, "main");
    const target = join(root, "one", "a checkout");
    const other = join(root, "two", "a checkout");
    const companion = join(root, "companion");
    mkdirSync(main);
    mkdirSync(join(root, "one"));
    symlinkSync(join(root, "one"), join(root, "alias"));
    const selection = { in: "companion" as const, mainWorktree: main, companionDir: companion };
    const storage = resolveWorkspaceStorage(selection, target);
    const digest = createHash("sha256").update(target).digest("hex");
    expect(storage.registryDir).toBe(join(companion, ".local-wt/workspace-registry"));
    expect(storage.runtimeDir).toBe(join(companion, ".local-wt/worktrees", `a_checkout-${digest}`));
    expect(resolveWorkspaceStorage(selection, join(root, "alias", "a checkout"))).toEqual(storage);
    expect(resolveWorkspaceStorage(selection, other).runtimeDir).not.toBe(storage.runtimeDir);
    expect(resolveWorkspaceStorage(selection, other).registryDir).toBe(storage.registryDir);
    expect(resolveWorkspaceStorage({ ...selection, in: "project" }, target)).toMatchObject({
      registryDir: join(main, ".local-wt/workspace-registry"),
      runtimeDir: join(target, ".local-wt"),
    });
    expect(existsSync(companion)).toBe(false);
    expect(existsSync(join(main, ".local-wt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
