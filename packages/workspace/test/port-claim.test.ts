import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import { checkPortClaim } from "../src/port-claim.js";
import type { PortRange } from "../src/ports.js";

const dirs: string[] = [];
const range: PortRange = { first: 8100, last: 8119 };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("port claim", () => {
  it("skips the check when .alignfirst.json is absent", () => {
    expect(() => checkPortClaim(temp(), range)).not.toThrow();
  });

  it("accepts a matching claim and ignores unrelated keys", () => {
    const dir = temp();
    writeConfig(dir, { schemaVersion: 1, other: true, portRange: { first: 8100, last: 8119 } });
    expect(() => checkPortClaim(dir, range)).not.toThrow();
  });

  it("reports both ranges for a mismatch, naming the dev-server's `ports` group", () => {
    const dir = temp();
    writeConfig(dir, { portRange: { first: 8200, last: 8219 } });
    expect(() => checkPortClaim(dir, range)).toThrow(
      /8200\.\.8219; the `ports` group of dev-server\.mjs claims 8100\.\.8119/,
    );
  });

  it("requires a claim when the dev-server declares ports", () => {
    const dir = temp();
    writeConfig(dir, { schemaVersion: 1 });
    expect(() => checkPortClaim(dir, range)).toThrow(/declares no `portRange`.*8100\.\.8119/);
  });

  it("rejects a claim when the dev-server is portless", () => {
    const dir = temp();
    writeConfig(dir, { portRange: { first: 8100, last: 8119 } });
    expect(() => checkPortClaim(dir, undefined)).toThrow(/dev-server\.mjs declares no `ports`/);
  });

  it("treats another portRange shape as absent", () => {
    const dir = temp();
    writeConfig(dir, { portRange: { first: "8100", last: 8119 } });
    expect(() => checkPortClaim(dir, undefined)).not.toThrow();
  });

  it("reports invalid JSON", () => {
    const dir = temp();
    writeFileSync(join(dir, ".alignfirst.json"), "{");
    expect(() => checkPortClaim(dir, range)).toThrow(ConfigError);
    expect(() => checkPortClaim(dir, range)).toThrow(
      `${join(dir, ".alignfirst.json")} is not valid JSON`,
    );
  });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-port-claim-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, value: unknown): void {
  writeFileSync(join(dir, ".alignfirst.json"), JSON.stringify(value));
}
