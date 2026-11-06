import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjectReport } from "../../src/project/layout.js";

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
    { ...report(cwd), locations: {} },
    Object.fromEntries(Object.entries(report(cwd)).filter(([key]) => key !== "aligndev")),
    Object.fromEntries(Object.entries(report(cwd)).filter(([key]) => key !== "workspace")),
    Object.fromEntries(Object.entries(report(cwd)).filter(([key]) => key !== "selectionOrigins")),
    {
      ...report(cwd),
      workspace: { location: {}, schemaVersion: null, portRange: null, hasDevServer: false },
    },
  ])("requires the workspace-aware contract, not a version number: %#", (value) => {
    const command = reportCommand(value);
    const result = readProjectReport(command, cwd, {});
    expect(result).toHaveProperty("error");
  });

  it.each([null, { profile: "work" }, { profile: " Work " }])(
    "carries a selection independently of the companion: %j",
    (aligndev) => {
      const value = { ...report(cwd), aligndev };
      expect(readProjectReport(reportCommand(value), cwd, {})).toEqual(value);
    },
  );

  it.each([{}, "work", { profile: 1 }, { profile: "  " }, { profile: "work", extra: true }])(
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
    expect(f.invocations()).toEqual([["config", "--json"], ["--version"]]);
  });

  it("resolves relative PATH entries from the child cwd and skips directories", () => {
    const f = executableFixture("alignfirst", {});
    const shadow = join(f.dir, "shadow");
    mkdirSync(join(shadow, "alignfirst"), { recursive: true });
    const result = readProjectReport(["alignfirst"], cwd, {
      PATH: [relative(cwd, shadow), relative(cwd, f.dir)].join(delimiter),
    });
    expect(result).toMatchObject({ error: expect.stringContaining(f.executable) });
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
    expect(f.invocations()).toEqual([["config", "--json"]]);
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
    expect(f.invocations()).toEqual([["config", "--json"]]);
  });

  it.each(["\n", "\r\n"])(
    "separates settings warnings from the first failure diagnostic with %j line endings",
    (newline) => {
      const error = "Invalid alignfirst.json: git.commit.style must be conventionalCommit";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const f = executableFixture(
        "alignfirst",
        {},
        "0.21.0\n",
        [...warnings, error, "private-child-value", "Warning: private-child-warning"].join(newline),
        1,
      );
      expect(readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toEqual({ error });
      expect(warn.mock.calls).toEqual(warnings.map((line) => [line]));
      expect(log).not.toHaveBeenCalled();
      expect(f.invocations()).toEqual([["config", "--json"]]);
    },
  );

  it.each(["", "  \n", "private-child-error\nprivate-child-detail"])(
    "preserves the existing failure fallback and first-line behavior for %j",
    (stderr) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = executableFixture("alignfirst", {}, "0.21.0\n", stderr, 1);
      const result = readProjectReport(["alignfirst"], cwd, { PATH: f.dir });
      expect(result).toHaveProperty("error");
      if (stderr.trim() !== "") expect(result).toEqual({ error: "private-child-error" });
      expect(warn).not.toHaveBeenCalled();
    },
  );

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
    expect(f.invocations()).toEqual([
      ["-y", "alignfirst", "config", "--json"],
      ["-y", "alignfirst", "--version"],
    ]);
  });

  it("diagnoses a missing PATH command", () => {
    const f = executableFixture("unused", {});
    expect(() => readProjectReport(["alignfirst"], cwd, { PATH: f.dir })).toThrow(Error);
  });

  it.each(["bad json", "null"])(
    "diagnoses the invalid report %j with the alignfirst used",
    (text) => {
      const command = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)})`];
      expect(() => readProjectReport(command, cwd, {})).toThrow(Error);
    },
  );

  it("rejects the retired plans.folder report field", () => {
    const command = reportCommand({
      ...report(cwd),
      source: "project",
      config: { schemaVersion: 1, plans: { folder: "project-plans" } },
    });
    expect(() => readProjectReport(command, cwd, {})).toThrow(Error);
  });
});

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
  const log = join(dir, "invocations.jsonl");
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (!args.includes("--version")) process.stderr.write(${JSON.stringify(stderr)});
process.stdout.write(args.includes("--version") ? ${JSON.stringify(version)} : ${JSON.stringify(JSON.stringify(value))});
if (!args.includes("--version")) process.exitCode = ${status};
`,
  );
  chmodSync(executable, 0o755);
  return {
    dir,
    executable,
    invocations: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function report(cwd: string) {
  const location = { path: cwd, in: "project", exists: false };
  const names = [
    "alignfirst",
    ".alignfirst-instructions",
    "assistantInstructionsFile",
    "workspaceRuntime",
    "docs",
    ".plans",
    "_aligndev",
  ];
  return {
    source: null,
    workspace: {
      location,
      schemaVersion: null,
      portRange: null,
      hasDevServer: false,
      registryDir: join(cwd, ".local-wt/workspace-registry"),
      runtimeDir: join(cwd, ".local-wt"),
    },
    config: null,
    companion: null,
    aligndev: null,
    locations: Object.fromEntries(
      names.map((name) => [name, name === "assistantInstructionsFile" ? null : location]),
    ),
    selectionOrigins: Object.fromEntries(names.map((name) => [name, "builtin"])),
  };
}

function reportCommand(report: object): string[] {
  const json = JSON.stringify(report);
  return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(json)})`];
}
