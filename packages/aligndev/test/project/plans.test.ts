import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCommandForms } from "../../src/command-form.js";
import { type PlansContext, validateEffectivePlans } from "../../src/project/plans.js";
import { quote } from "../stand-ins.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateEffectivePlans", () => {
  it("extracts the target through one JSON gate call in the supplied cwd and environment", () => {
    const target = join(tmpdir(), "plans target");
    const fixture = gateCommand(JSON.stringify({ plans: { target } }));
    expect(validateEffectivePlans(fixture.ctx)).toBe(target);
    expect(fixture.invocations()).toEqual([
      ["plans check --json", fixture.ctx.cwd, "supplied environment", fixture.ctx.env.HOME],
    ]);
  });

  it("preserves supplied multiline refusal diagnostics", () => {
    const diagnostic =
      "Effective .plans is tracked.\nUntrack it, then commit.\nUse plans setup <clone-dir>.\n";
    const fixture = gateCommand("not a success report", diagnostic, 1);
    expect(() => validateEffectivePlans(fixture.ctx)).toThrow(diagnostic.trimEnd());
    expect(fixture.invocations()).toHaveLength(1);
  });

  it("fails closed when AlignFirst refuses without a diagnostic", () => {
    const fixture = gateCommand(JSON.stringify({ plans: { target: tmpdir() } }), "", 1);
    expect(() => validateEffectivePlans(fixture.ctx)).toThrow(Error);
  });

  it("rejects a human-readable report without falling back to parsing it", () => {
    const fixture = gateCommand("Work files ready: /plans");
    expect(() => validateEffectivePlans(fixture.ctx)).toThrow(Error);
    expect(fixture.invocations()).toHaveLength(1);
  });

  it.each([
    null,
    { plans: {} },
    { plans: { target: "   " } },
    { plans: { target: "relative/.plans" } },
  ])("rejects missing or invalid target data: %j", (report) => {
    const fixture = gateCommand(JSON.stringify(report));
    expect(() => validateEffectivePlans(fixture.ctx)).toThrow(Error);
    expect(fixture.invocations()).toHaveLength(1);
  });
});

interface GateFixture {
  ctx: PlansContext;
  invocations(): unknown;
}

function gateCommand(stdout: string, stderr = "", status = 0): GateFixture {
  const dir = mkdtempSync(join(tmpdir(), "aligndev-plans-"));
  dirs.push(dir);
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const log = join(dir, "invocations.log");
  const script = join(dir, "alignfirst");
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$(pwd)" "$GATE_PROBE" "$HOME" >> ${quote(log)}
printf '%s' ${quote(stdout)}
printf '%s' ${quote(stderr)} >&2
exit ${status}
`,
    { mode: 0o755 },
  );
  return {
    ctx: {
      cwd: realpathSync(cwd),
      env: { HOME: dir, GATE_PROBE: "supplied environment" },
      alignfirstCommand: [script],
      forms: resolveCommandForms({}),
    },
    invocations: () =>
      readFileSync(log, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.split("|")),
  };
}
