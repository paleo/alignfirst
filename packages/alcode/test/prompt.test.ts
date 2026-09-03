import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/prompt.js";

describe("buildPrompt", () => {
  it("passes the raw message through when no protocol", () => {
    expect(buildPrompt({ message: "just this" })).toBe("just this");
  });

  it("builds a protocol prompt with ticket and message", () => {
    expect(buildPrompt({ protocol: "spec", ticket: "1234", message: "m" })).toBe(
      "Run `alignfirst guide spec` and follow the protocol. Ticket ID = 1234.\n\nm",
    );
  });

  it("uses the CLI protocol name", () => {
    expect(buildPrompt({ protocol: "aad", ticket: "1", message: "m" })).toBe(
      "Run `alignfirst guide aad` and follow the protocol. Ticket ID = 1.\n\nm",
    );
  });

  it("omits the ticket and message parts when absent", () => {
    expect(buildPrompt({ protocol: "plan" })).toBe(
      "Run `alignfirst guide plan` and follow the protocol.",
    );
  });

  it("builds the catchup protocol prompt", () => {
    expect(buildPrompt({ protocol: "catchup", ticket: "29", message: "What changed?" })).toBe(
      "Run `alignfirst guide catchup` and follow the protocol. Ticket ID = 29.\n\nWhat changed?",
    );
  });
});
