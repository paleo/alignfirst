import { describe, expect, it } from "vitest";
import { leadingCli } from "../src/runner.js";

describe("leadingCli", () => {
  it.each<{ input: unknown; expected: string | undefined }>([
    { input: { command: "npm test" }, expected: "npm" },
    { input: { command: "cd /x && npm test" }, expected: "npm" },
    { input: { command: "cd /a && cd /b && ls -la" }, expected: "ls" },
    { input: { command: "FOO=bar npm test" }, expected: "npm" },
    { input: { command: "FOO=bar BAZ=qux node script.js" }, expected: "node" },
    { input: { command: "cd /x && FOO=bar npm test" }, expected: "npm" },
    { input: { command: "FOO=bar" }, expected: undefined },
    { input: { command: "/usr/bin/node script.js" }, expected: "node" },
    { input: { command: "./scripts/run.sh" }, expected: "run.sh" },
    { input: {}, expected: undefined },
    { input: { command: 42 }, expected: undefined },
    { input: undefined, expected: undefined },
    { input: null, expected: undefined },
    { input: { command: '"/path with space/foo"' }, expected: undefined },
  ])("reads $expected from $input", ({ input, expected }) => {
    expect(leadingCli(input)).toBe(expected);
  });
});
