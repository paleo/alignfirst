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

  it("builds the special read prompt with a ticket", () => {
    expect(buildPrompt({ protocol: "read", ticket: "29" })).toBe(
      "Use the *alignfirst* skill to determine the TASK_DIR for ticket 29. " +
        "Then read every `*spec.md` and `*summary.md` file in the TASK_DIR.",
    );
  });

  it("appends the message to a read prompt", () => {
    expect(buildPrompt({ protocol: "read", ticket: "7", message: "What changed?" })).toBe(
      "Use the *alignfirst* skill to determine the TASK_DIR for ticket 7. " +
        "Then read every `*spec.md` and `*summary.md` file in the TASK_DIR.\n\nWhat changed?",
    );
  });
});
