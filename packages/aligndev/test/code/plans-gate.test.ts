import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { readMachineId } from "../../src/code/machine-id.js";
import { makeSink, writeConfig } from "../helpers.js";
import { writeAlignfirstStub } from "../stand-ins.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coding launch plans gate", () => {
  it.each(["new", "resume"])(
    "refuses %s before stale-session reconciliation or ticket/model effects",
    async (command) => {
      const base = mkdtempSync(join(tmpdir(), "aligndev-gate-"));
      dirs.push(base);
      const project = join(base, "project");
      const home = join(base, "home");
      mkdirSync(project);
      writeConfig(home, { code: { harness: "pi" } });
      // The sessions live in the companion; the project's `.plans` is missing.
      const companion = join(base, "companion");
      const stub = writeAlignfirstStub(base, project, {
        companion: { dir: companion, items: { _aligndev: "companion" } },
      });
      const sessions = join(companion, ".plans", "_aligndev");
      mkdirSync(sessions, { recursive: true });
      const file = join(sessions, "stale.md");
      const contents = `---\nagent: pi\nprofile: test\nsessionId: stale\nstatus: running\npid: 2147483647\nmachineId: ${readMachineId(home)}\nstartedAt: 2026-01-01T00:00:00.000Z\ncwd: ${project}\n---\n\nkeep\n`;
      writeFileSync(file, contents);
      const run = async (args: string[]) => {
        const stdout = makeSink();
        const stderr = makeSink();
        const code = await main({
          argv: ["node", "aligndev", "code", ...args],
          cwd: project,
          home,
          env: { HOME: home },
          alignfirstCommand: stub.command,
          stdout,
          stderr,
        });
        return { code, stdout: stdout.text(), stderr: stderr.text() };
      };
      const resume = command === "resume" ? ["stale"] : [];
      expect((await run([command, ...resume, "--ticket", "123", "-m", "work"])).code).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(contents);
      expect(stub.invocations()).not.toContain("ticket 123 --json");
      const status = await run(["status", file, "--result"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("status: failed");
      expect((await run(["--help"])).code).toBe(0);
      expect(existsSync(join(project, ".plans"))).toBe(false);
    },
  );
});
