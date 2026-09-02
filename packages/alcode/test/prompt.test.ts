import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/prompt.js";

describe("buildPrompt", () => {
  it("passes the raw message through when no protocol", () => {
    expect(buildPrompt({ message: "just this" })).toBe("just this");
  });

  it("builds a protocol prompt with ticket and message", () => {
    expect(buildPrompt({ protocol: "spec", ticket: "29", message: "Do X" })).toBe(
      "Run the _spec_ protocol from the *alignfirst* skill. Ticket ID = 29.\n\nDo X",
    );
  });

  it("uses the AAD label for the aad protocol", () => {
    expect(buildPrompt({ protocol: "aad", ticket: "1", message: "m" })).toBe(
      "Run the _AAD_ protocol from the *alignfirst* skill. Ticket ID = 1.\n\nm",
    );
  });

  it("omits the ticket and message parts when absent", () => {
    expect(buildPrompt({ protocol: "plan" })).toBe(
      "Run the _plan_ protocol from the *alignfirst* skill.",
    );
  });

  it("builds the catchup protocol prompt", () => {
    expect(buildPrompt({ protocol: "catchup", ticket: "29", message: "What changed?" })).toBe(
      "Run the _catchup_ protocol from the *alignfirst* skill. Ticket ID = 29.\n\nWhat changed?",
    );
  });
});
