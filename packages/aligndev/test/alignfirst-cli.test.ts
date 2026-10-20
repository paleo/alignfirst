import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAlignfirst } from "../src/alignfirst-cli.js";

const warnings = [
  "Warning: ignoring unknown .alignfirst.json setting plans.extra. Remove it or check its spelling.",
  "Warning: ignoring unknown companion registry setting projects[<entry>].aligndev.extra. Remove it or check its spelling.",
  'Warning: /project/.alignfirst.json: plans.folder is deprecated; rename it to plans.repositoryFolder. See "Rename the Work-Files Folder Setting" in the setup guide\'s alignfirst-upgrade reference.',
];
const privateMessages = [
  "private-child-stderr-value",
  "Warning: private-child-warning-value",
  "Error: private-child-error-value",
  "Warning: ignoring unknown unrelated setting private-value",
  "Warning: ignoring unknown .alignfirst.json setting bad\u001b[31m. private-value",
];

afterEach(() => vi.restoreAllMocks());

describe("runAlignfirst settings warnings", () => {
  it.each([["config", "--json"], ["context"], ["ticket", "27", "--json"]])(
    "forwards only settings warnings from successful %j without changing captured output",
    (...args) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderr = [...warnings, ...privateMessages].join("\r\n");
      const result = runChild(args, stderr, 0);
      expect(result).toEqual({ status: 0, stdout: '{"ok":true}\n', stderr });
      expect(warn.mock.calls).toEqual(warnings.map((line) => [line]));
      expect(log).not.toHaveBeenCalled();
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    },
  );

  it("leaves failed-invocation diagnostics to the caller", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderr = [...warnings, ...privateMessages].join("\n");
    expect(runChild(["config", "--json"], stderr, 1).stderr).toBe(stderr);
    expect(warn).not.toHaveBeenCalled();
  });
});

function runChild(args: string[], stderr: string, status: number) {
  return runAlignfirst(
    [
      process.execPath,
      "-e",
      `process.stdout.write('{"ok":true}\\n');
process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${status};`,
      "--",
    ],
    args,
    tmpdir(),
    {},
  );
}
