import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMachineId } from "../../src/code/machine-id.js";
import { writeConfig } from "../helpers.js";
import {
  execGit,
  makeFixture,
  makeRepository,
  runAligndev,
  useProjectFixtures,
} from "../project/fixtures.js";

useProjectFixtures();

describe("coding launch plans gate", () => {
  it.each(["new", "resume"])(
    "refuses %s before stale-session reconciliation or ticket/model effects",
    async (command) => {
      const fixture = makeFixture();
      const repo = makeRepository(fixture.root, "app");
      writeConfig(fixture.home, { code: { agent: "pi" } });
      const sessions = join(repo, ".plans", "_aligndev");
      mkdirSync(sessions, { recursive: true });
      const file = join(sessions, "stale.md");
      const contents = `---\nagent: pi\nprofile: test\nsessionId: stale\nstatus: running\npid: 2147483647\nmachineId: ${readMachineId(fixture.home)}\nstartedAt: 2026-01-01T00:00:00.000Z\ncwd: ${repo}\n---\n\nkeep\n`;
      writeFileSync(file, contents);
      execGit(repo, "add", ".plans");
      execGit(repo, "commit", "--quiet", "-m", "tracked plans");
      const result = await runAligndev(
        fixture,
        [
          "code",
          command,
          ...(command === "resume" ? ["stale"] : []),
          "--ticket",
          "123",
          "-m",
          "work",
        ],
        { cwd: repo },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("tracked");
      expect(result.stderr).toContain("the `work-files-setup` topic of `aligndev guide`");
      expect(readFileSync(file, "utf8")).toBe(contents);
      expect(existsSync(join(repo, ".plans", "123"))).toBe(false);
      const status = await runAligndev(fixture, ["code", "status", file, "--result"], {
        cwd: repo,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("status: failed");
      expect(status.stderr).not.toContain("tracked");
      expect((await runAligndev(fixture, ["code", "--help"], { cwd: repo })).code).toBe(0);
    },
  );
});
