import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeAlignfirst,
  forwardSettingsWarnings,
  loadCatchup,
  loadContext,
  openTicket,
  reserveSideTicket,
  runAlignfirst,
} from "../src/alignfirst-cli.js";
import { resolveCommandForms } from "../src/command-form.js";

const warnings = [
  "Warning: ignoring unknown companion registry setting projects[<entry>].aligndev.extra. Remove it or check its spelling.",
  "Warning: developerInstructions is deprecated in /project/alignfirst.json; use assistantInstructionsFile instead. assistantInstructionsFile takes precedence when both are set.",
  "Warning: developerInstructions is deprecated in companion registry projects[<entry>].items; use assistantInstructionsFile instead. assistantInstructionsFile takes precedence when both are set.",
  "Warning: developer-instructions is deprecated; use assistant-instructions instead.",
  "Warning: assistantInstructionsFile is deprecated in /project/alignfirst.json. Rename the assistant guide to ASSISTANTS.md and remove the property.",
];
const privateMessages = [
  "Warning: ignoring unknown .alignfirst.json setting plans.extra. Remove it or check its spelling.",
  'Warning: /project/.alignfirst.json: plans.folder is deprecated; rename it to plans.repositoryFolder. See "Rename the Work-Files Folder Setting" in `alignfirst setup guide upgrade`.',
  "private-child-stderr-value",
  "Warning: private-child-warning-value",
  "Error: private-child-error-value",
  "Warning: ignoring unknown unrelated setting private-value",
  "Warning: ignoring unknown .alignfirst.json setting bad\u001b[31m. private-value",
  "Warning: developerInstructions is deprecated in /project/alignfirst.json; private-child-value",
  "Warning: developer-instructions is deprecated; private-child-value",
  ...["\u001b", "​", " ", " "].flatMap((control) =>
    warnings.map((warning) =>
      warning.replace(/setting |deprecated in |deprecated; /u, `$&${control}`),
    ),
  ),
];

afterEach(() => vi.restoreAllMocks());

describe("structured runner argv", () => {
  it("records every operation under the npm runner", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aligndev-runner-"));
    try {
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const log = join(cwd, "argv.log");
      const env = { PATH: bin, npm_config_user_agent: "npm/1", npm_command: "exec" };
      const forms = resolveCommandForms(env, {
        runtime: "node",
        env,
        cwd,
        executable: process.execPath,
      });
      const command = [forms.counterpart.executable, ...forms.counterpart.args];
      writeFileSync(
        join(bin, command[0]),
        `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$3" = --version ]; then echo 0.14.1; else echo '{"TICKET_ID":"side-1"}'; fi
`,
        { mode: 0o755 },
      );
      runAlignfirst(command, ["config", "--json"], cwd, env);
      runAlignfirst(command, ["plans", "check", "--json"], cwd, env);
      expect(reserveSideTicket(command, cwd, env)).toBe("side-1");
      openTicket(command, cwd, "side-1", env);
      loadCatchup(command, cwd, "side-1", env);
      loadContext(command, cwd, env);
      expect(describeAlignfirst(command, cwd, env)).toContain("0.14.1");
      expect(readFileSync(log, "utf8").trimEnd().split("\n")).toEqual(
        [
          "config --json",
          "plans check --json",
          "ticket --side --json",
          "ticket side-1 --json",
          "ticket side-1 --catchup",
          "context",
          "--version",
        ].map((args) => `-y alignfirst ${args}`),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("settings warnings", () => {
  it("forwards only settings warnings and returns the other diagnostics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = forwardSettingsWarnings([...warnings, ...privateMessages].join("\r\n"));
    expect(warn.mock.calls).toEqual(warnings.map((line) => [line]));
    expect(diagnostics).toBe(privateMessages.join("\n"));
  });

  it("leaves failed-invocation diagnostics to the caller", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderr = warnings.join("\n");
    const result = runAlignfirst(
      ["/bin/sh", "-c", 'printf "%s" "$0" >&2; exit 1', stderr],
      [],
      tmpdir(),
      {},
    );
    expect(result).toMatchObject({ status: 1, stderr });
    expect(warn).not.toHaveBeenCalled();
  });
});
