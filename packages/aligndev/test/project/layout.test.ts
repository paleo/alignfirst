import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjectReport, readProjectReports } from "../../src/project/layout.js";
import { buildReport as report, quote } from "../stand-ins.js";

const dirs: string[] = [];
const warnings = [
  "Warning: ignoring unknown companion registry setting projects[<entry>].aligndev.extra. Remove it or check its spelling.",
  "Warning: developerInstructions is deprecated in /project/alignfirst.json; use assistantInstructionsFile instead. assistantInstructionsFile takes precedence when both are set.",
  "Warning: developerInstructions is deprecated in companion registry projects[<entry>].items; use assistantInstructionsFile instead. assistantInstructionsFile takes precedence when both are set.",
  "Warning: developer-instructions is deprecated; use assistant-instructions instead.",
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readProjectReport", () => {
  const cwd = tmpdir();

  it.each([
    { source: "root", cli: null, config: null },
    Object.fromEntries(Object.entries(report(cwd)).filter(([key]) => key !== "aligndev")),
    {
      ...report(cwd),
      workspace: { location: {}, schemaVersion: null, portRange: null, hasDevServer: false },
    },
  ])("requires the workspace-aware contract, not a version number: %#", (value) => {
    const command = reportCommand(value);
    const result = readProjectReport(command, cwd, {});
    expect(result).toHaveProperty("error");
  });

  it.each([null, { profile: " Work " }])(
    "carries a selection independently of the companion: %j",
    (aligndev) => {
      const value = { ...report(cwd), aligndev };
      expect(readProjectReport(reportCommand(value), cwd, {})).toEqual(value);
    },
  );

  it.each([{}, { profile: "  " }, { profile: "work", extra: true }])(
    "rejects a malformed selection: %j",
    (aligndev) => {
      expect(() => readProjectReport(reportCommand({ ...report(cwd), aligndev }), cwd, {})).toThrow(
        Error,
      );
    },
  );

  it("diagnoses an outdated executable on PATH with its version", () => {
    const f = executableFixture("alignfirst", {});
    const result = readProjectReport(["alignfirst"], cwd, { PATH: f.dir });
    expect(result).toMatchObject({ error: expect.stringContaining(f.executable) });
    expect(result).toMatchObject({ error: expect.stringContaining("0.21.0") });
    expect(f.invocations()).toEqual(["config --json", "--version"]);
  });

  it("omits oversized version output and keeps diagnostics on one line", () => {
    const f = executableFixture("alignfirst", {}, `${"x".repeat(81)}\n`);
    const result = readProjectReport(["alignfirst", "line\nbreak"], cwd, { PATH: f.dir });
    if (!("error" in result)) throw new Error("expected report failure");
    expect(result.error).not.toContain("x".repeat(81));
    expect(result.error).not.toContain("\n");
    expect(result.error).toContain("line break");
  });

  it("does no diagnostic work for a valid report", () => {
    const f = executableFixture("alignfirst", report(cwd));
    expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toEqual(report(cwd));
    expect(f.invocations()).toEqual(["config --json"]);
  });

  it("forwards settings warnings without leaking arbitrary successful report stderr", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = executableFixture(
      "alignfirst",
      report(cwd),
      "0.21.0\n",
      [...warnings, "Warning: private-child-value", "private-child-value", ""].join("\n"),
    );
    expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toEqual(report(cwd));
    expect(warn.mock.calls).toEqual(warnings.map((line) => [line]));
    expect(f.invocations()).toEqual(["config --json"]);
  });

  it("separates settings warnings from the first failure diagnostic", () => {
    const error = "Invalid alignfirst.json: git.commit.style must be conventionalCommit";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = executableFixture(
      "alignfirst",
      {},
      "0.21.0\n",
      [...warnings, error, "private-child-value", "Warning: private-child-warning"].join("\r\n"),
      1,
    );
    expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toEqual({ error });
    expect(warn.mock.calls).toEqual(warnings.map((line) => [line]));
    expect(log).not.toHaveBeenCalled();
    expect(f.invocations()).toEqual(["config --json"]);
  });

  it("keeps the first line of a failure diagnostic", () => {
    const stderr = "private-child-error\nprivate-child-detail";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = executableFixture("alignfirst", {}, "0.21.0\n", stderr, 1);
    expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toEqual({
      error: "private-child-error",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a generic failure when stderr contains only recognized settings warnings", () => {
    const warning =
      "Warning: ignoring unknown companion registry setting extra. Remove it or check its spelling.";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = executableFixture("alignfirst", {}, "0.21.0\n", `${warning}\n`, 1);
    expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toHaveProperty("error");
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it("uses the same package runner for the report and version probe", () => {
    const f = executableFixture("npx", {});
    const result = readProjectReport(["npx", "-y", "alignfirst"], cwd, { PATH: f.dir });
    if (!("error" in result)) throw new Error("expected report failure");
    expect(f.invocations()).toEqual(["-y alignfirst config --json", "-y alignfirst --version"]);
  });

  it("diagnoses a missing PATH command", () => {
    const f = executableFixture("unused", {});
    expect(() => readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toThrow(Error);
  });

  it("diagnoses an invalid report with the alignfirst used", () => {
    expect(() => readProjectReport(printCommand("bad json"), cwd, {})).toThrow(Error);
  });

  it("rejects the retired plans.folder report field", () => {
    const command = reportCommand({
      ...report(cwd),
      source: "project",
      config: { schemaVersion: 1, plans: { folder: "project-plans" } },
    });
    expect(() => readProjectReport(command, cwd, {})).toThrow(Error);
  });
});

describe("readProjectReports", () => {
  const cwd = tmpdir();
  const directories = [join(cwd, "a"), join(cwd, "b")];

  it("returns one result per directory, in order", () => {
    const f = executableFixture("alignfirst", {
      reports: [
        { path: directories[0], error: "Invalid alignfirst.json" },
        { path: directories[1], report: report(directories[1]) },
      ],
    });
    expect(readProjectReports(["alignfirst"], directories, cwd, { PATH: f.dir })).toEqual([
      { error: "Invalid alignfirst.json" },
      report(directories[1]),
    ]);
  });

  const current = report(directories[0]);
  const { aligndev: _, ...withoutAligndev } = current;
  it("reports an outdated entry as a project error without failing the batch", () => {
    const f = executableFixture("alignfirst", {
      reports: [
        { path: directories[0], report: withoutAligndev },
        { path: directories[1], report: report(directories[1]) },
      ],
    });
    const results = readProjectReports(["alignfirst"], directories, cwd, { PATH: f.dir });
    expect(results[0]).toHaveProperty("error");
    expect(results[1]).toEqual(report(directories[1]));
  });

  it.each([
    { reports: [{ path: directories[0], report: report(directories[0]) }] },
    { reports: [null, { path: directories[1], report: report(directories[1]) }] },
  ])("rejects a malformed batch report: %#", (value) => {
    const f = executableFixture("alignfirst", value);
    expect(() => readProjectReports(["alignfirst"], directories, cwd, { PATH: f.dir })).toThrow(
      Error,
    );
  });

  it("advises an upgrade when alignfirst rejects the directory arguments", () => {
    const stderr = `Unexpected argument: ${directories[0]}\n\nUsage: alignfirst config [--json]\n`;
    const f = executableFixture("alignfirst", {}, "0.21.0\n", stderr, 1);
    expect(() => readProjectReports(["alignfirst"], directories, cwd, { PATH: f.dir })).toThrow(
      /Upgrade alignfirst/,
    );
  });

  it("keeps the first diagnostic of any other failure", () => {
    const stderr = "npm error code ENOTCACHED\nnpm error detail\n";
    const f = executableFixture("alignfirst", {}, "0.21.0\n", stderr, 1);
    const run = () => readProjectReports(["alignfirst"], directories, cwd, { PATH: f.dir });
    expect(run).toThrow("npm error code ENOTCACHED");
    expect(run).not.toThrow(/Upgrade alignfirst/);
  });
});

// A shell executable `name` that answers `value` as JSON, or `version` to `--version`.
function executableFixture(
  name: string,
  value: object,
  version = "0.21.0\n",
  stderr = "",
  status = 0,
) {
  const dir = mkdtempSync(join(tmpdir(), "aligndev-report-"));
  dirs.push(dir);
  const executable = join(dir, name);
  const log = join(dir, "invocations.log");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
case " $* " in
  *" --version "*) printf '%s' ${quote(version)} ;;
  *) printf '%s' ${quote(stderr)} >&2; printf '%s' ${quote(JSON.stringify(value))}; exit ${status} ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    dir,
    executable,
    invocations: () => readFileSync(log, "utf8").trimEnd().split("\n"),
  };
}

function reportCommand(report: object): string[] {
  return printCommand(JSON.stringify(report));
}

function printCommand(text: string): string[] {
  return ["/bin/sh", "-c", `printf '%s' ${quote(text)}`];
}
