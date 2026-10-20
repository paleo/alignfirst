import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchManaged } from "../src/process-tree.js";
import { isLive, records, waitFor } from "./process-tree-helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));

describe.skipIf(process.platform !== "linux")("default process cleanup grace", () => {
  it("allows five seconds before killing TERM-resistant descendants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tree-grace-"));
    const managed = launchManaged({
      command: process.execPath,
      args: [fixture, dir, "ignoring"],
      cwd: dir,
      stdout: () => {},
      stderr: () => {},
      inputError: () => {},
    });
    try {
      expect(await managed.spawned).toBeUndefined();
      await waitFor(() => records(dir).length >= 2);
      const started = Date.now();
      await managed.stop();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(8_000);
      expect(records(dir).filter(isLive)).toEqual([]);
    } finally {
      for (const record of records(dir)) {
        if (isLive(record)) process.kill(record.pid, "SIGKILL");
      }
      await managed.stop(Date.now()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);
});
