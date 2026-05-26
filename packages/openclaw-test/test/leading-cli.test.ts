import { describe, expect, it } from "vitest";
import { leadingCli } from "../src/runner.js";

describe("leadingCli", () => {
  it("returns the command name for a plain command", () => {
    expect(leadingCli({ command: "npm test" })).toBe("npm");
  });

  it("strips a leading `cd … &&` chain", () => {
    expect(leadingCli({ command: "cd /x && npm test" })).toBe("npm");
    expect(leadingCli({ command: "cd /a && cd /b && ls -la" })).toBe("ls");
  });

  it("skips env-var assignments before the command", () => {
    expect(leadingCli({ command: "FOO=bar npm test" })).toBe("npm");
    expect(leadingCli({ command: "FOO=bar BAZ=qux node script.js" })).toBe("node");
    expect(leadingCli({ command: "cd /x && FOO=bar npm test" })).toBe("npm");
  });

  it("rejects a bare env-var assignment with no trailing command", () => {
    expect(leadingCli({ command: "FOO=bar" })).toBeUndefined();
  });

  it("takes the basename of an absolute path", () => {
    expect(leadingCli({ command: "/usr/bin/node script.js" })).toBe("node");
    expect(leadingCli({ command: "./scripts/run.sh" })).toBe("run.sh");
  });

  it("returns undefined for non-string or missing command", () => {
    expect(leadingCli({})).toBeUndefined();
    expect(leadingCli({ command: 42 })).toBeUndefined();
    expect(leadingCli(undefined)).toBeUndefined();
    expect(leadingCli(null)).toBeUndefined();
  });

  it("returns undefined for an unparseable leading token", () => {
    expect(leadingCli({ command: '"/path with space/foo"' })).toBeUndefined();
  });
});
