import { describe, expect, it } from "vitest";

import { type AlcoachArgs, parseAlcoachArgs, validateArgs } from "../src/cli.js";

function parse(flags: string[]): AlcoachArgs {
  return parseAlcoachArgs(["node", "alcoach", ...flags]);
}

function validate(flags: string[]): string | undefined {
  return validateArgs(parse(flags));
}

describe("parseAlcoachArgs", () => {
  it("reads the flags into camelCase fields", () => {
    const args = parse(["--new", "--protocol", "aad", "--ticket", "29", "--message", "go"]);
    expect(args.isNew).toBe(true);
    expect(args.protocol).toBe("aad");
    expect(args.ticket).toBe("29");
    expect(args.message).toBe("go");
  });

  it("throws on unknown flags", () => {
    expect(() => parse(["--nope"])).toThrow();
  });
});

describe("validateArgs — parity with the retired .mjs", () => {
  it("rejects --new with --resume", () => {
    expect(validate(["--new", "--resume", "s"])).toBe(
      "Error: --new and --resume are mutually exclusive.",
    );
  });

  it("requires one of --new or --resume", () => {
    expect(validate(["--message", "hi"])).toBe(
      "Error: at least one of --new or --resume is required.",
    );
  });

  it("rejects an unknown protocol", () => {
    expect(validate(["--new", "--protocol", "bogus", "--ticket", "1"])).toBe(
      "Error: --protocol must be one of: spec, plan, aad, description, read, review, merge.",
    );
  });

  it("requires --message when no protocol", () => {
    expect(validate(["--new"])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
  });

  it("requires --ticket with --new + --protocol", () => {
    expect(validate(["--new", "--protocol", "plan"])).toBe(
      "Error: --ticket is required with --new and --protocol.",
    );
  });

  it("requires --message for spec and aad", () => {
    expect(validate(["--new", "--protocol", "spec", "--ticket", "1"])).toBe(
      "Error: --protocol spec requires --message.",
    );
    expect(validate(["--new", "--protocol", "aad", "--ticket", "1"])).toBe(
      "Error: --protocol aad requires --message.",
    );
  });

  it("rejects --ticket without --new", () => {
    expect(validate(["--resume", "s", "--ticket", "1", "--message", "m"])).toBe(
      "Error: --ticket is only valid with --new.",
    );
  });

  it("accepts a valid spec run", () => {
    expect(validate(["--new", "--protocol", "spec", "--ticket", "1", "--message", "m"])).toBe(
      undefined,
    );
  });

  it("accepts a resume with no protocol and a message", () => {
    expect(validate(["--resume", "s", "--message", "answer"])).toBe(undefined);
  });
});
