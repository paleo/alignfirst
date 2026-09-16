import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  createQuotaReader,
  formatCodexQuota,
  parseClaudeQuota,
  type QuotaProcessAdapter,
} from "../src/quota.js";

describe("Claude quota", () => {
  it("calls the native usage command with a filtered environment", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: "Current session: 25% used",
      }),
    }));
    const reader = createQuotaReader({
      execute,
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });

    await expect(
      reader("claude", {
        cwd: "/project",
        env: {
          PATH: "/bin",
          KEEP: "yes",
          SECRET: "remove",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ALIGNFIRST_CODE_AGENT: "claude",
          ALIGNFIRST_CODE_UNSET: "SECRET",
        },
      }),
    ).resolves.toBe("Claude Code quota\n\nCurrent session: 25% used");
    expect(execute).toHaveBeenCalledWith(
      "claude",
      ["-p", "/usage", "--tools", "", "--output-format", "json", "--no-session-persistence"],
      {
        cwd: "/project",
        env: {
          PATH: "/bin",
          KEEP: "yes",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          DISABLE_FEEDBACK_COMMAND: "1",
          DISABLE_BUG_COMMAND: "1",
          CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
        },
        timeout: 30_000,
      },
    );
  });

  it("reports native command failures", async () => {
    const reader = createQuotaReader({
      execute: async () => {
        throw new Error("claude exited with code 1");
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });

    await expect(reader("claude", { cwd: "/project", env: {} })).rejects.toThrow(
      "claude exited with code 1",
    );
  });

  it("extracts the native zero-turn usage report", () => {
    expect(
      parseClaudeQuota(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          total_cost_usd: 0,
          num_turns: 0,
          result: "  Current session: 25% used  ",
        }),
      ),
    ).toBe("  Current session: 25% used");
  });

  it("omits the local insights section", () => {
    expect(
      parseClaudeQuota(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          result:
            "Current session: 25% used\nCurrent week: 40% used\n\n" +
            "What's contributing to your limits usage?\nLocal session details",
        }),
      ),
    ).toBe("Current session: 25% used\nCurrent week: 40% used");
  });

  it("rejects malformed, failed, and limit-free responses", () => {
    expect(() => parseClaudeQuota("nope")).toThrow("malformed usage JSON");
    expect(() =>
      parseClaudeQuota(JSON.stringify({ subtype: "error", is_error: true, result: "failed" })),
    ).toThrow("could not read");
    expect(() =>
      parseClaudeQuota(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          result: "What's contributing to your limits usage?\nLocal session details",
        }),
      ),
    ).toThrow("no usage limits");
  });
});

describe("Codex quota", () => {
  const cwd = process.cwd();

  it("initializes app-server and requests rate limits", async () => {
    const fakeServer = nodeProcessAdapter(`
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin });
      let step = 0;
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (step === 0 && message.method === "initialize" && message.id === 0) {
          step = 1;
          process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");
          return;
        }
        if (step === 1 && message.method === "initialized") {
          step = 2;
          return;
        }
        if (step === 2 && message.method === "account/rateLimits/read" && message.id === 1) {
          process.stdout.write(JSON.stringify({
            id: 1,
            result: {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: null }
              },
              rateLimitsByLimitId: null
            }
          }) + "\\n");
          return;
        }
        process.stderr.write("unexpected protocol message\\n");
        process.exit(7);
      });
    `);
    const reader = createQuotaReader(fakeServer.adapter);

    await expect(
      reader("codex", {
        cwd,
        env: { KEEP: "yes", ALIGNFIRST_CODE_AGENT: "codex" },
      }),
    ).resolves.toContain("5 hours: 15% used");
    expect(fakeServer.request).toEqual({
      file: "codex",
      args: ["app-server"],
      options: { cwd, env: { KEEP: "yes" } },
    });
  });

  it("reports app-server protocol errors", async () => {
    const fakeServer = nodeProcessAdapter(`
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin });
      let initialized = false;
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 0) {
          process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");
          return;
        }
        if (message.method === "initialized") {
          initialized = true;
          return;
        }
        if (initialized && message.id === 1) {
          process.stdout.write(JSON.stringify({
            id: 1,
            error: { message: "account unavailable" }
          }) + "\\n");
        }
      });
    `);

    await expect(createQuotaReader(fakeServer.adapter)("codex", { cwd, env: {} })).rejects.toThrow(
      "Codex could not read usage limits: account unavailable",
    );
  });

  it("reports early app-server exits", async () => {
    const fakeServer = nodeProcessAdapter(`
      process.stderr.write("not authenticated\\n");
      process.exit(7);
    `);

    await expect(createQuotaReader(fakeServer.adapter)("codex", { cwd, env: {} })).rejects.toThrow(
      "Codex could not read usage limits: not authenticated",
    );
  });

  it("terminates an app-server that times out", async () => {
    const fakeServer = nodeProcessAdapter("setInterval(() => {}, 1_000);");

    await expect(
      createQuotaReader(fakeServer.adapter, 20)("codex", { cwd, env: {} }),
    ).rejects.toThrow("Codex timed out while reading usage limits");
  });

  it("renders only the account bucket and both windows", () => {
    const response = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 100 },
        secondary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 200 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 100 },
          secondary: null,
        },
        spark: {
          limitId: "spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 200 },
          secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 300 },
        },
      },
    };

    expect(formatCodexQuota(response, (timestamp) => `time-${timestamp}`)).toBe(
      "Codex quota\n\n" +
        "Codex\n" +
        "  1 week: 7% used · resets time-100\n" +
        "  5 hours: 8% used · resets time-200",
    );
  });

  it("falls back to the legacy bucket and tolerates missing reset metadata", () => {
    expect(
      formatCodexQuota(
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
    expect(() => formatCodexQuota({ rateLimits: {}, rateLimitsByLimitId: {} })).toThrow(
      "no usage windows",
    );
  });
});

interface ProcessRequest {
  file: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv };
}

function nodeProcessAdapter(script: string): {
  adapter: QuotaProcessAdapter;
  readonly request: ProcessRequest | undefined;
} {
  let request: ProcessRequest | undefined;
  return {
    adapter: {
      execute: async () => {
        throw new Error("unexpected execute");
      },
      spawn(file, args, options) {
        request = { file, args, options };
        return spawn(process.execPath, ["-e", script], {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    },
    get request() {
      return request;
    },
  };
}
