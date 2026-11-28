import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { isProcessAlive, isProcessGroupAlive, stopProcessGroup } from "../src/process-control.js";

describe("stopProcessGroup", () => {
  it("escalates a TERM-resistant group to SIGKILL at the deadline, children included", async () => {
    const leader = spawn("sh", ["-c", "trap '' TERM; sleep 30 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [line] = await once(leader.stdout, "data");
    const child = Number(String(line).trim());
    const pid = leader.pid;
    if (pid === undefined) throw new Error("Missing group leader PID");
    const exited = once(leader, "exit");
    const started = Date.now();
    await stopProcessGroup(pid, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
    await expect.poll(() => isProcessGroupAlive(pid)).toBe(false);
    await expect.poll(() => isProcessAlive(child)).toBe(false);
  });
});
