import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { readProjectReport } from "../../src/project/layout.js";

describe("readProjectReport", () => {
  it("names the minimum alignfirst version for a report without locations", () => {
    const report = JSON.stringify({ source: "root", cli: null, config: null });
    const command = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(report)})`];
    const cwd = tmpdir();
    expect(() => readProjectReport(command, cwd, process.env)).toThrow(
      `The alignfirst CLI used in ${cwd} is too old: aligndev requires alignfirst 0.5.0 or later.`,
    );
  });
});
