import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { readProjectReport } from "../../src/project/layout.js";

describe("readProjectReport", () => {
  const cwd = tmpdir();
  const tooOld = `The alignfirst CLI used in ${cwd} is too old: aligndev requires the profile-aware alignfirst config --json contract (top-level "aligndev"). Upgrade alignfirst.`;

  it.each([
    { source: "root", cli: null, config: null },
    { ...report(cwd), locations: {} },
    Object.fromEntries(Object.entries(report(cwd)).filter(([key]) => key !== "aligndev")),
  ])("requires the profile-aware contract, not a version number: %#", (value) => {
    expect(readProjectReport(reportCommand(value), cwd, {})).toEqual({ error: tooOld });
  });

  it.each([null, { profile: "work" }, { profile: " Work " }])(
    "carries a selection independently of the companion: %j",
    (aligndev) => {
      const value = { ...report(cwd), aligndev };
      expect(readProjectReport(reportCommand(value), cwd, {})).toEqual(value);
    },
  );

  it.each([
    {},
    [],
    "work",
    false,
    { profile: null },
    { profile: 1 },
    { profile: "" },
    { profile: "  " },
    { profile: "work", extra: true },
  ])("rejects a malformed selection: %j", (aligndev) => {
    expect(() => readProjectReport(reportCommand({ ...report(cwd), aligndev }), cwd, {})).toThrow(
      `Invalid alignfirst config report for ${cwd}`,
    );
  });

  it("retains the legacy plans.folder parser for compatible reports", () => {
    const command = reportCommand({
      ...report(cwd),
      source: "project",
      config: { schemaVersion: 1, plans: { folder: "project-plans" } },
    });
    expect(readProjectReport(command, cwd, {})).toMatchObject({
      config: { plans: { repositoryFolder: "project-plans" } },
    });
  });
});

function report(cwd: string) {
  const location = { path: cwd, in: "project", exists: false };
  const names = [
    ".alignfirst.json",
    ".alignfirst-instructions",
    "DEVELOPERS.md",
    "docs",
    ".plans",
    "_aligndev",
  ];
  return {
    source: null,
    cli: null,
    config: null,
    companion: null,
    aligndev: null,
    locations: Object.fromEntries(names.map((name) => [name, location])),
  };
}

function reportCommand(report: object): string[] {
  const json = JSON.stringify(report);
  return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(json)})`];
}
