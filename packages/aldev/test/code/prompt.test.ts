import { describe, expect, it } from "vitest";

import { buildPrompt } from "../../src/code/prompt.js";

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

  it("places bounded catchup context before the one selected protocol", () => {
    const history = "- .plans/29/A1-spec.md (40000 bytes)";
    const prompt = buildPrompt({
      protocol: "aad",
      ticket: "29",
      message: "Continue the fix",
      catchupContent: history,
    });
    expect(prompt).toContain(`## Ticket history\n\n${history}`);
    expect(prompt.indexOf(history)).toBeLessThan(prompt.indexOf("Run `alignfirst guide aad`"));
    expect(prompt).toMatch(/Continue the fix$/);
    expect(prompt).not.toContain("guide catchup");
  });

  it.each(["", " \n"])("summarizes catchup when the supplied message is blank", (message) => {
    expect(buildPrompt({ catchupContent: "History", message })).toContain(
      "Summarize the ticket history briefly",
    );
  });

  it("puts the project context first, then the history, then the instruction", () => {
    expect(
      buildPrompt({
        protocol: "plan",
        ticket: "29",
        catchupContent: "History",
        contextContent: "Conventions\n",
      }),
    ).toBe(
      [
        "## Project context",
        "Conventions",
        "## Ticket history",
        "History",
        "## Current instruction",
        "Run `alignfirst guide plan` and follow the protocol. Ticket ID = 29.",
      ].join("\n\n"),
    );
  });

  it("sections the instruction after the project context without catchup", () => {
    expect(buildPrompt({ message: "Fix it", contextContent: "Conventions" })).toBe(
      "## Project context\n\nConventions\n\n## Current instruction\n\nFix it",
    );
  });

  it("summarizes the history after the project context when the message is empty", () => {
    const prompt = buildPrompt({ catchupContent: "History", contextContent: "Conventions" });
    expect(prompt).toMatch(/^## Project context\n\nConventions\n\n## Ticket history\n\nHistory/);
    expect(prompt).toMatch(/## Current instruction\n\nSummarize the ticket history briefly/);
  });

  it("defaults standalone catchup to a short synthesis and honors a supplied question", () => {
    expect(buildPrompt({ catchupContent: "History" })).toContain(
      "Summarize the ticket history briefly",
    );
    const prompt = buildPrompt({ catchupContent: "History", message: "What remains?" });
    expect(prompt).toMatch(/What remains\?$/);
    expect(prompt).not.toContain("Summarize");
  });
});
