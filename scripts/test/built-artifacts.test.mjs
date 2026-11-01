import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireBuiltArtifacts } from "./built-artifacts.mjs";

test("integration preflight accepts built files and reports all missing entries with a remedy", () => {
  const root = mkdtempSync(join(tmpdir(), "built-artifacts-"));
  try {
    const built = join(root, "cli.js");
    const executable = join(root, "cli");
    writeFileSync(built, "");
    symlinkSync(built, executable);
    requireBuiltArtifacts([built, executable]);

    const missing = join(root, "missing.js");
    const directory = join(root, "not-a-file.js");
    mkdirSync(directory);
    assert.throws(() => requireBuiltArtifacts([built, missing, directory]), (error) => {
      assert.match(error.message, /npm run build.*repository root/);
      assert.ok(error.message.includes(missing));
      assert.ok(error.message.includes(directory));
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
