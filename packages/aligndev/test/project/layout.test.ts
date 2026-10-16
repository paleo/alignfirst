import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { readProjectReport } from "../../src/project/layout.js";

describe("readProjectReport", () => {
  const cwd = tmpdir();
  const tooOld = `The alignfirst CLI used in ${cwd} is too old: aligndev requires alignfirst 0.9.0 or later.`;

  it("names the minimum alignfirst version for a report without locations", () => {
    const command = reportCommand({ source: "root", cli: null, config: null });
    expect(readProjectReport(command, cwd, process.env)).toEqual({ error: tooOld });
  });

  it("names the minimum alignfirst version for a report without .alignfirst-instructions", () => {
    const location = { path: cwd, in: "project", exists: false };
    const command = reportCommand({
      source: null,
      cli: null,
      config: null,
      companion: null,
      locations: { ".alignfirst.json": location, ".alignfirst.md": location },
    });
    expect(readProjectReport(command, cwd, process.env)).toEqual({ error: tooOld });
  });

  it("reads plans.folder from an alignfirst older than 0.12.0", () => {
    const location = { path: cwd, in: "project", exists: false };
    const names = [
      ".alignfirst.json",
      ".alignfirst-instructions",
      "DEVELOPERS.md",
      "docs",
      ".plans",
    ];
    const command = reportCommand({
      source: "project",
      cli: null,
      config: { schemaVersion: 1, plans: { folder: "project-plans" } },
      companion: null,
      locations: Object.fromEntries([...names, "_aligndev"].map((name) => [name, location])),
    });
    expect(readProjectReport(command, cwd, process.env)).toMatchObject({
      config: { plans: { repositoryFolder: "project-plans" } },
    });
  });
});

function reportCommand(report: object): string[] {
  const json = JSON.stringify(report);
  return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(json)})`];
}
