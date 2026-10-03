import { describe, expect, it } from "vitest";

import { buildPrompt } from "../../src/code/prompt.js";

const ALIGNFIRST = "alignfirst";

describe("buildPrompt", () => {
  it("passes the raw message through when no protocol", () => {
    expect(buildPrompt({ alignfirst: ALIGNFIRST, message: "just this" })).toBe("just this");
  });

  it("builds a protocol prompt with ticket and message", () => {
    expect(
      buildPrompt({ alignfirst: ALIGNFIRST, protocol: "spec", ticket: "1234", message: "m" }),
    ).toBe("Run `alignfirst guide spec` and follow the protocol. Ticket ID = 1234.\n\nm");
  });

  it("names the alignfirst command form it is given", () => {
    expect(buildPrompt({ alignfirst: "npx -y alignfirst", protocol: "plan" })).toBe(
      "Run `npx -y alignfirst guide plan` and follow the protocol.",
    );
  });

  it("uses the CLI protocol name", () => {
    expect(
      buildPrompt({ alignfirst: ALIGNFIRST, protocol: "aad", ticket: "1", message: "m" }),
    ).toBe("Run `alignfirst guide aad` and follow the protocol. Ticket ID = 1.\n\nm");
  });

  it("omits the ticket and message parts when absent", () => {
    expect(buildPrompt({ alignfirst: ALIGNFIRST, protocol: "plan" })).toBe(
      "Run `alignfirst guide plan` and follow the protocol.",
    );
  });

  it("places bounded catchup context before the one selected protocol", () => {
    const history = "- .plans/29/A1-spec.md (40000 bytes)";
    const prompt = buildPrompt({
      alignfirst: ALIGNFIRST,
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
    expect(buildPrompt({ alignfirst: ALIGNFIRST, catchupContent: "History", message })).toContain(
      "Summarize the ticket history briefly",
    );
  });

  it("puts the project context first, then the history, then the instruction", () => {
    expect(
      buildPrompt({
        alignfirst: ALIGNFIRST,
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
    expect(
      buildPrompt({ alignfirst: ALIGNFIRST, message: "Fix it", contextContent: "Conventions" }),
    ).toBe("## Project context\n\nConventions\n\n## Current instruction\n\nFix it");
  });

  it("summarizes the history after the project context when the message is empty", () => {
    const prompt = buildPrompt({
      alignfirst: ALIGNFIRST,
      catchupContent: "History",
      contextContent: "Conventions",
    });
    expect(prompt).toMatch(/^## Project context\n\nConventions\n\n## Ticket history\n\nHistory/);
    expect(prompt).toMatch(/## Current instruction\n\nSummarize the ticket history briefly/);
  });

  it("defaults standalone catchup to a short synthesis and honors a supplied question", () => {
    expect(buildPrompt({ alignfirst: ALIGNFIRST, catchupContent: "History" })).toContain(
      "Summarize the ticket history briefly",
    );
    const prompt = buildPrompt({
      alignfirst: ALIGNFIRST,
      catchupContent: "History",
      message: "What remains?",
    });
    expect(prompt).toMatch(/What remains\?$/);
    expect(prompt).not.toContain("Summarize");
  });
});
