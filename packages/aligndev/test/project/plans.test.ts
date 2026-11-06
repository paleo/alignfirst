import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCommandForms } from "../../src/command-form.js";
import { type PlansContext, validateEffectivePlans } from "../../src/project/plans.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateEffectivePlans", () => {
  it("extracts the target through one JSON gate call in the supplied cwd and environment", () => {
    const target = join(tmpdir(), "plans target");
    const fixture = gateCommand(JSON.stringify({ plans: { target } }));
    expect(validateEffectivePlans(fixture.ctx)).toBe(target);
    expect(fixture.invocations()).toEqual([
      {
        args: ["plans", "check", "--json"],
        cwd: fixture.ctx.cwd,
        probe: "supplied environment",
        home: fixture.ctx.env.HOME,
      },
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
    {},
    { plans: "ready" },
    { plans: {} },
    { plans: { target: 42 } },
    { plans: { target: "   " } },
    { plans: { target: "relative/.plans" } },
  ])("rejects missing or invalid target data: %j", (report) => {
    const fixture = gateCommand(JSON.stringify(report));
    expect(() => validateEffectivePlans(fixture.ctx)).toThrow(Error);
    expect(fixture.invocations()).toHaveLength(1);
  });

  it("keeps recognized successful warnings on stderr without forwarding them twice", () => {
    const warning =
      "Warning: ignoring unknown companion registry setting extra. Remove it or check its spelling.";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = gateCommand(
      JSON.stringify({ plans: { target: tmpdir() } }),
      `${warning}\nprivate child diagnostic\n`,
    );
    expect(validateEffectivePlans(fixture.ctx)).toBe(tmpdir());
    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
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
  const log = join(dir, "invocations.jsonl");
  const script = join(dir, "alignfirst.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), probe: process.env.GATE_PROBE,
  home: process.env.HOME,
}) + "\\n");
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${status};
`,
  );
  return {
    ctx: {
      cwd: realpathSync(cwd),
      env: { HOME: dir, GATE_PROBE: "supplied environment" },
      alignfirstCommand: [process.execPath, script],
      forms: resolveCommandForms({}),
    },
    invocations: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
