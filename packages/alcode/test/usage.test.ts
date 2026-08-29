import { describe, expect, it } from "vitest";

import { formatCodexUsage, parseClaudeUsage } from "../src/usage.js";

describe("Claude usage", () => {
  it("extracts the native zero-turn usage report", () => {
    expect(
      parseClaudeUsage(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          total_cost_usd: 0,
          num_turns: 0,
          result: "  Current session: 25% used  ",
        }),
      ),
    ).toBe("Current session: 25% used");
  });

  it("rejects malformed, failed, and empty responses", () => {
    expect(() => parseClaudeUsage("nope")).toThrow("malformed usage JSON");
    expect(() =>
      parseClaudeUsage(JSON.stringify({ subtype: "error", is_error: true, result: "failed" })),
    ).toThrow("could not read");
    expect(() =>
      parseClaudeUsage(JSON.stringify({ subtype: "success", is_error: false, result: " " })),
    ).toThrow("empty usage report");
  });
});

describe("Codex usage", () => {
  it("renders every structured bucket and window", () => {
    const response = {
      rateLimits: {},
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 100 },
          secondary: null,
        },
        spark: {
          limitId: "spark",
          limitName: "Spark",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 200 },
          secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 300 },
        },
      },
    };

    expect(formatCodexUsage(response, (timestamp) => `time-${timestamp}`)).toBe(
      "Codex usage\n\n" +
        "Codex\n" +
        "  1 week: 7% used · resets time-100\n\n" +
        "Spark\n" +
        "  5 hours: 12% used · resets time-200\n" +
        "  1 week: 34% used · resets time-300",
    );
  });

  it("falls back to the legacy bucket and tolerates missing reset metadata", () => {
    expect(
      formatCodexUsage(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null },
          },
          rateLimitsByLimitId: null,
        },
        () => "unused",
      ),
    ).toContain("Primary window: 50% used");
  });

  it("rejects responses without quota windows", () => {
    expect(() => formatCodexUsage({ rateLimits: {}, rateLimitsByLimitId: {} })).toThrow(
      "no usage windows",
    );
  });
});
