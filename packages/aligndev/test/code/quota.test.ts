import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createQuotaReader,
  formatCodexQuota,
  parseClaudeQuota,
  type QuotaProcessAdapter,
} from "../../src/code/quota.js";

const roots: string[] = [];
const servers: FixtureServer[] = [];
const context = { cwd: process.cwd(), env: {} };
const protocolScript = `
  const lines = require("node:readline").createInterface({ input: process.stdin });
  let step = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (step === 0 && message.method === "initialize" && message.id === 0) {
      step = 1;
      console.log(JSON.stringify({ id: 0, result: {} }));
    } else if (step === 1 && message.method === "initialized") {
      step = 2;
    } else if (step === 2 && message.method === "account/rateLimits/read" && message.id === 1) {
      step = 3;
      console.log(JSON.stringify(RESPONSE));
    } else process.exit(7);
  });
`;
const validResponse = {
  id: 1,
  result: { rateLimits: { primary: { usedPercent: 15, windowDurationMins: 300 } } },
};

afterEach(async () => {
  // Also discharge ownership when an assertion or fixture unexpectedly fails.
  for (const server of servers.splice(0)) {
    const child = server.child;
    if (child === undefined || server.closed) continue;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGKILL");
    });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude quota", () => {
  it("copies the finalized environment before translating privacy settings", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({ subtype: "success", result: "Current session: 25% used" }),
    }));
    const env = { KEEP: "yes", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    const reader = createQuotaReader({
      execute,
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });
    await expect(reader("claude", { cwd: "/project", env })).resolves.toContain("25% used");
    expect(env).toEqual({ KEEP: "yes", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(execute).toHaveBeenCalledWith(
      "claude",
      ["-p", "/usage", "--tools", "", "--output-format", "json", "--no-session-persistence"],
      {
        cwd: "/project",
        env: {
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

  it("extracts only limits from the native zero-turn usage report", () => {
    expect(
      parseClaudeQuota(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          num_turns: 0,
          total_cost_usd: 0,
          result:
            "  Current session: 25% used\nCurrent week: 40% used\n\n" +
            "What's contributing to your limits usage?\nLocal session details",
        }),
      ),
    ).toBe("  Current session: 25% used\nCurrent week: 40% used");
  });

  it.each([
    ["nope", "malformed usage JSON"],
    [
      JSON.stringify({ subtype: "error", is_error: true, result: "fixture-secret" }),
      "could not read",
    ],
    [JSON.stringify({ subtype: "success", result: "No limits" }), "no usage limits"],
  ])("rejects malformed, failed and limit-free responses", (input, message) => {
    expect(() => parseClaudeQuota(input)).toThrow(message);
  });

  it.each([
    ['console.log(JSON.stringify({subtype:"success",result:"25% used"}));', "25% used"],
    ['console.error("fixture-secret"); process.exitCode = 2;', "check native authentication"],
    ['process.stdout.write("x".repeat(1_048_577));', "output exceeded"],
  ])(
    "runs the default Claude executable only inside a disposable fixture",
    async (script, expected) => {
      const root = mkdtempSync(join(tmpdir(), "aligndev-native-claude-"));
      roots.push(root);
      writeFileSync(join(root, "claude"), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
      const result = createQuotaReader()("claude", { cwd: root, env: { HOME: root, PATH: root } });
      if (expected === "25% used") await expect(result).resolves.toContain(expected);
      else {
        await expect(result).rejects.toThrow(expected);
        await expect(result).rejects.not.toThrow("fixture-secret");
      }
    },
  );

  it.each([false, true])(
    "awaits default Claude timeout cleanup (TERM resistant: %s)",
    async (resistant) => {
      const root = mkdtempSync(join(tmpdir(), "aligndev-quota-"));
      roots.push(root);
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}\n${resistant ? 'process.on("SIGTERM", () => {});' : ""}
require("node:fs").writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid));
console.log(JSON.stringify({subtype:"success",result:"25% used"}));
setInterval(() => {}, 1000);\n`,
        { mode: 0o755 },
      );
      await expect(
        createQuotaReader(undefined, 1000)("claude", {
          cwd: root,
          env: { HOME: root, PATH: bin },
        }),
      ).rejects.toThrow("Claude Code timed out");
      const pid = Number(readFileSync(join(root, "pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("does not expose failed executable output or arguments", async () => {
    const reader = createQuotaReader({
      execute: async () => {
        throw new Error("command fixture-secret stderr fixture-secret");
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });
    await expect(reader("claude", context)).rejects.toThrow(/Claude Code quota command failed/);
    await expect(reader("claude", context)).rejects.not.toThrow("fixture-secret");
  });
});

describe("Codex quota process", () => {
  it("initializes app-server, requests limits, closes pipes and releases its exit guard", async () => {
    const before = process.listenerCount("exit");
    const server = nodeProcessAdapter(
      protocolScript.replace("RESPONSE", JSON.stringify(validResponse)),
    );
    await expect(createQuotaReader(server.adapter)("codex", context)).resolves.toContain(
      "5 hours: 15% used",
    );
    expect(server.request).toEqual({ file: "codex", args: ["app-server"], options: context });
    expect(server.closed).toBe(true);
    expect(server.child?.stdin.writableEnded).toBe(true);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it.each([
    [
      protocolScript.replace(
        "RESPONSE",
        JSON.stringify({ id: 1, error: { message: "fixture-secret" } }),
      ),
      /check native authentication/,
    ],
    [protocolScript.replace("RESPONSE", JSON.stringify({ id: 1, result: {} })), /no usage windows/],
    ['process.stderr.write("fixture-secret\\n"); process.exit(7);', /exited before returning/],
    [
      'console.log("not json fixture-secret"); setInterval(() => {}, 1000);',
      /malformed quota JSON/,
    ],
    [
      "console.log(JSON.stringify({ id: 0, error: {} })); setInterval(() => {}, 1000);",
      /could not initialize/,
    ],
    [
      "console.log(JSON.stringify({ id: 1 })); setInterval(() => {}, 1000);",
      /could not read usage limits/,
    ],
    [
      'process.stdout.write("x".repeat(1_048_577)); setInterval(() => {}, 1000);',
      /output exceeded/,
    ],
    [
      'process.stderr.write("x".repeat(1_048_577)); setInterval(() => {}, 1000);',
      /output exceeded/,
    ],
  ])("cleans up failed native exchanges without exposing output", async (script, message) => {
    const before = process.listenerCount("exit");
    const server = nodeProcessAdapter(script);
    const result = createQuotaReader(server.adapter)("codex", context);
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toThrow("fixture-secret");
    expect(server.closed).toBe(true);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("awaits timeout cleanup", async () => {
    const server = nodeProcessAdapter("setInterval(() => {}, 1000);");
    await expect(createQuotaReader(server.adapter, 30)("codex", context)).rejects.toThrow(
      "Codex timed out",
    );
    expect(server.closed).toBe(true);
  });

  it("escalates a successful but TERM-resistant server to KILL before returning", async () => {
    const server = nodeProcessAdapter(
      'process.on("SIGTERM", () => {});\n' +
        protocolScript.replace("RESPONSE", JSON.stringify(validResponse)) +
        "\nsetInterval(() => {}, 1000);",
    );
    await expect(createQuotaReader(server.adapter)("codex", context)).resolves.toContain(
      "15% used",
    );
    expect(server.closed).toBe(true);
    expect(server.child?.signalCode).toBe("SIGKILL");
  });

  it("handles broken stdin without an uncaught error and awaits cleanup", async () => {
    const server = nodeProcessAdapter("setInterval(() => {}, 1000);", true);
    await expect(createQuotaReader(server.adapter)("codex", context)).rejects.toThrow(
      "could not write",
    );
    expect(server.closed).toBe(true);
  });

  it.each(["claude", "codex"] as const)(
    "reports missing %s without reading real configuration",
    async (source) => {
      const root = mkdtempSync(join(tmpdir(), "aligndev-missing-quota-"));
      roots.push(root);
      await expect(
        createQuotaReader()(source, { cwd: root, env: { HOME: root, PATH: root } }),
      ).rejects.toThrow(/quota process could not start/);
    },
  );
});

describe("Codex quota buckets", () => {
  it("prefers the named codex bucket, including a weekly-only primary", () => {
    expect(
      formatCodexQuota(
        {
          rateLimits: { primary: { usedPercent: 99 } },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 100 },
            },
            spark: { limitId: "spark", primary: { usedPercent: 88 } },
          },
        },
        (timestamp) => `time-${timestamp}`,
      ),
    ).toBe("Codex quota\n\nCodex\n  1 week: 7% used · resets time-100");
  });

  it.each([
    [300, 10_080, "5 hours", "1 week"],
    [10_080, 300, "1 week", "5 hours"],
  ])(
    "derives both window labels from duration, independent of position",
    (primary, secondary, firstLabel, secondLabel) => {
      expect(
        formatCodexQuota({
          rateLimits: {
            primary: { usedPercent: 7, windowDurationMins: primary },
            secondary: { usedPercent: 8, windowDurationMins: secondary },
          },
        }),
      ).toBe(`Codex quota\n\nCodex\n  ${firstLabel}: 7% used\n  ${secondLabel}: 8% used`);
    },
  );

  it.each([undefined, null, "codex"])(
    "accepts legacy Codex identity %s and unknown metadata",
    (limitId) => {
      expect(formatCodexQuota({ rateLimits: { limitId, primary: { usedPercent: 50 } } })).toContain(
        "Primary window: 50% used",
      );
    },
  );

  it.each([
    { rateLimits: { limitId: "spark", primary: { usedPercent: 10 } } },
    { rateLimitsByLimitId: { codex: { limitId: "spark", primary: { usedPercent: 10 } } } },
  ])("rejects contradictory non-Codex identities", (response) => {
    expect(() => formatCodexQuota(response)).toThrow("different limit bucket");
  });

  it.each([null, {}, "invalid", { primary: { usedPercent: -1 } }])(
    "does not fall back from a present malformed authoritative snapshot",
    (codex) => {
      expect(() =>
        formatCodexQuota({
          rateLimits: { primary: { usedPercent: 10 } },
          rateLimitsByLimitId: { codex },
        }),
      ).toThrow("malformed named codex snapshot");
    },
  );

  it.each([
    { usedPercent: Number.NaN },
    { usedPercent: Number.POSITIVE_INFINITY },
    { usedPercent: -1 },
    { usedPercent: 101 },
    { usedPercent: "50" },
    { usedPercent: 10, windowDurationMins: 0 },
    { usedPercent: 10, windowDurationMins: -1 },
    { usedPercent: 10, windowDurationMins: Number.POSITIVE_INFINITY },
    { usedPercent: 10, windowDurationMins: "300" },
    { usedPercent: 10, resetsAt: Number.NaN },
    { usedPercent: 10, resetsAt: Number.POSITIVE_INFINITY },
    { usedPercent: 10, resetsAt: -1 },
    { usedPercent: 10, resetsAt: 8_640_000_000_001 },
    { usedPercent: 10, resetsAt: "100" },
  ])("discards malformed windows but preserves valid remaining windows: %j", (primary) => {
    expect(() => formatCodexQuota({ rateLimits: { primary } })).toThrow("no usage windows");
    expect(
      formatCodexQuota({
        rateLimits: { primary, secondary: { usedPercent: 0, windowDurationMins: 1440 } },
      }),
    ).toContain("1 day: 0% used");
  });

  it("retains null/absent duration and reset, accepts the full valid percentage range", () => {
    expect(
      formatCodexQuota(
        {
          rateLimits: {
            primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null },
            secondary: { usedPercent: 100, resetsAt: 0 },
          },
        },
        () => "epoch",
      ),
    ).toContain("Secondary window: 100% used · resets epoch");
  });

  it("accepts valid Date timestamp boundaries without throwing from Intl", () => {
    expect(
      formatCodexQuota({
        rateLimits: { primary: { usedPercent: 1, resetsAt: 8_640_000_000_000 } },
      }),
    ).toContain("1% used · resets");
  });

  it.each([
    {},
    null,
    { rateLimits: {} },
    { rateLimitsByLimitId: { spark: { primary: { usedPercent: 10 } } } },
  ])("rejects missing windows without discovering another bucket", (response) => {
    expect(() => formatCodexQuota(response)).toThrow(/usage (response|windows)/);
  });
});

interface FixtureServer {
  adapter: QuotaProcessAdapter;
  readonly request:
    | { file: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }
    | undefined;
  readonly child: ChildProcessWithoutNullStreams | undefined;
  readonly closed: boolean;
}

function nodeProcessAdapter(script: string, brokenInput = false): FixtureServer {
  let request: FixtureServer["request"];
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  const server: FixtureServer = {
    adapter: {
      execute: async () => {
        throw new Error("unexpected execute");
      },
      spawn(file, args, options) {
        request = { file, args, options };
        child = spawn(process.execPath, ["-e", script], {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.once("close", () => {
          closed = true;
        });
        if (brokenInput) child.stdin.destroy(new Error("fixture-secret"));
        return child;
      },
    },
    get request() {
      return request;
    },
    get child() {
      return child;
    },
    get closed() {
      return closed;
    },
  };
  servers.push(server);
  return server;
}
