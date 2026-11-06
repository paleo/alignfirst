import { describe, expect, it } from "vitest";

import { buildPrompt } from "../../src/code/prompt.js";

const RESUMED = { alignfirst: "alignfirst", newSession: false };

describe("buildPrompt", () => {
  it("preserves the raw message when no protocol or context is supplied", () => {
    const message = "Fix `a`\n$(do not execute)\n  preserve this indentation";
    expect(buildPrompt({ ...RESUMED, message })).toBe(message);
  });

  it("preserves supplied project context, history and instruction in that order", () => {
    const contextContent = "Conventions\n  Literal project input";
    const catchupContent = "- .plans/29/A1-spec.md (40000 bytes)";
    const message = "What remains?\n  Keep the supplied question.";
    const prompt = buildPrompt({
      ...RESUMED,
      contextContent,
      catchupContent,
      message,
    });
    expect(prompt).toContain(contextContent);
    expect(prompt).toContain(catchupContent);
    expect(prompt).toContain(message);
    expect(prompt.indexOf(contextContent)).toBeLessThan(prompt.indexOf(catchupContent));
    expect(prompt.indexOf(catchupContent)).toBeLessThan(prompt.indexOf(message));
  });
});
