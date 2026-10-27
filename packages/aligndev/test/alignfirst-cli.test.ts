import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeAlignfirst,
  loadCatchup,
  loadContext,
  openTicket,
  reserveSideTicket,
  runAlignfirst,
} from "../src/alignfirst-cli.js";
import { resolveCommandForms } from "../src/command-form.js";

const warnings = [
  "Warning: ignoring unknown companion registry setting projects[<entry>].aligndev.extra. Remove it or check its spelling.",
];
const privateMessages = [
  "Warning: ignoring unknown .alignfirst.json setting plans.extra. Remove it or check its spelling.",
  'Warning: /project/.alignfirst.json: plans.folder is deprecated; rename it to plans.repositoryFolder. See "Rename the Work-Files Folder Setting" in the setup guide\'s alignfirst-upgrade reference.',
  "private-child-stderr-value",
  "Warning: private-child-warning-value",
  "Error: private-child-error-value",
  "Warning: ignoring unknown unrelated setting private-value",
  "Warning: ignoring unknown .alignfirst.json setting bad\u001b[31m. private-value",
];

afterEach(() => vi.restoreAllMocks());

describe("structured runner argv", () => {
  it.each([
    ["node", "npm", ["-y", "alignfirst"]],
    ["node", "bun", ["alignfirst"]],
    ["bun", "bun", ["--bun", "alignfirst"]],
  ] as const)("records every operation under %s/%s", (runtime, manager, prefix) => {
    const cwd = mkdtempSync(join(tmpdir(), "aligndev-runner-"));
    try {
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const log = join(cwd, "argv.jsonl");
      const env = { PATH: bin, npm_config_user_agent: `${manager}/1`, npm_command: "exec" };
      const forms = resolveCommandForms(env, { runtime, env, cwd, executable: process.execPath });
      const command = [forms.counterpart.executable, ...forms.counterpart.args];
      writeFileSync(
        join(bin, command[0]),
        `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
console.log(args.includes("--version") ? "0.14.1" : JSON.stringify({TICKET_ID:"side-1"}));
`,
        { mode: 0o755 },
      );
      runAlignfirst(command, ["config", "--json"], cwd, env);
      runAlignfirst(command, ["plans", "check", "--json"], cwd, env);
      expect(reserveSideTicket(command, cwd, env)).toBe("side-1");
      openTicket(command, cwd, "side-1", env);
      loadCatchup(command, cwd, "side-1", env);
      loadContext(command, cwd, env);
      const description = describeAlignfirst(command, cwd, env);
      expect(description).toContain("version 0.14.1");
      if (manager === "bun") {
        expect(description).toContain("Bun package runner");
        expect(description).not.toContain("local alignfirst dependency");
      }
      expect(
        readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(
        [
          ["config", "--json"],
          ["plans", "check", "--json"],
          ["ticket", "--side", "--json"],
          ["ticket", "side-1", "--json"],
          ["ticket", "side-1", "--catchup"],
          ["context"],
          ["--version"],
        ].map((args) => [...prefix, ...args]),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("names missing Bun and a Bun-safe recovery", () => {
    expect(() =>
      runAlignfirst(["bunx", "--bun", "alignfirst"], ["config", "--json"], tmpdir(), { PATH: "" }),
    ).toThrow("relaunch with `bunx --bun aligndev`");
  });
});

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
