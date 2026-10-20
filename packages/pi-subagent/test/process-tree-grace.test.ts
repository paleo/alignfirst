import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchManaged } from "../src/process-tree.js";

const fixture = fileURLToPath(new URL("./fixtures/tree.mjs", import.meta.url));

interface FixturePid {
  pid: number;
  identity: string;
  role: string;
}

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

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture synchronization timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function records(dir: string): FixturePid[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("pid" in value) ||
        !("identity" in value) ||
        !("role" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 1 ||
        typeof value.identity !== "string" ||
        typeof value.role !== "string"
      )
        throw new Error("Invalid fixture PID record.");
      return { pid: value.pid, identity: value.identity, role: value.role };
    });
}

function isLive(record: FixturePid): boolean {
  try {
    const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === record.identity && fields[0] !== "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
