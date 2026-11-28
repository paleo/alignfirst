import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createQuotaReader,
  formatAgyQuota,
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
      expect.objectContaining({
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
      }),
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
    "nope",
    JSON.stringify({ subtype: "error", is_error: true, result: "fixture-secret" }),
    JSON.stringify({ subtype: "success", result: "No limits" }),
  ])("rejects malformed, failed and limit-free responses: %s", (input) => {
    expect(() => parseClaudeQuota(input)).toThrow(Error);
  });

  it.each([
    [`printf '%s\\n' '{"subtype":"success","result":"25% used"}'`, "25% used"],
    ["printf fixture-secret >&2\nexit 2", undefined],
    ["head -c 1048577 /dev/zero", undefined],
  ])(
    "runs the default Claude executable only inside a disposable fixture",
    async (script, expected) => {
      const root = makeRoot();
      writeFileSync(join(root, "claude"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      const result = createQuotaReader()("claude", { cwd: root, env: fixtureEnv(root) });
      if (expected === "25% used") await expect(result).resolves.toContain(expected);
      else {
        await expect(result).rejects.toThrow(Error);
        await expect(result).rejects.not.toThrow("fixture-secret");
      }
    },
  );

  it("awaits the cleanup of a TERM-resistant default Claude executable after its timeout", async () => {
    const root = makeRoot();
    const pidFile = join(root, "pid");
    writeFileSync(
      join(root, "claude"),
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > '${pidFile}'
printf '%s\\n' '{"subtype":"success","result":"25% used"}'
exec sleep 30
`,
      { mode: 0o755 },
    );
    await expect(
      createQuotaReader(undefined, 50)("claude", { cwd: root, env: fixtureEnv(root) }),
    ).rejects.toThrow(Error);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("Codex quota process", () => {
  it("initializes app-server, requests limits, closes pipes and releases its exit guard", async () => {
    const before = process.listenerCount("exit");
    const server = nodeProcessAdapter(
      protocolScript.replace("RESPONSE", JSON.stringify(validResponse)),
    );
    await expect(createQuotaReader(server.adapter)("codex", context)).resolves.toMatch(/\b15\b/);
    expect(server.request).toEqual({ file: "codex", args: ["app-server"], options: context });
    expect(server.closed).toBe(true);
    expect(server.child?.stdin.writableEnded).toBe(true);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it.each([
    protocolScript.replace(
      "RESPONSE",
      JSON.stringify({ id: 1, error: { message: "fixture-secret" } }),
    ),
    'process.stderr.write("fixture-secret\\n"); process.exit(7);',
    'console.log("not json fixture-secret"); setInterval(() => {}, 1000);',
    "console.log(JSON.stringify({ id: 0, error: {} })); setInterval(() => {}, 1000);",
    'process.stdout.write("x".repeat(1_048_577)); setInterval(() => {}, 1000);',
  ])("cleans up failed native exchanges without exposing output: %#", async (script) => {
    const before = process.listenerCount("exit");
    const server = nodeProcessAdapter(script);
    const result = createQuotaReader(server.adapter)("codex", context);
    await expect(result).rejects.toThrow(Error);
    await expect(result).rejects.not.toThrow("fixture-secret");
    expect(server.closed).toBe(true);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("awaits timeout cleanup", async () => {
    const server = nodeProcessAdapter("setInterval(() => {}, 1000);");
    await expect(createQuotaReader(server.adapter, 30)("codex", context)).rejects.toThrow(Error);
    expect(server.closed).toBe(true);
  });

  it("escalates a successful but TERM-resistant server to KILL before returning", async () => {
    const server = nodeProcessAdapter(
      'process.on("SIGTERM", () => {});\n' +
        protocolScript.replace("RESPONSE", JSON.stringify(validResponse)) +
        "\nsetInterval(() => {}, 1000);",
    );
    await expect(createQuotaReader(server.adapter)("codex", context)).resolves.toMatch(/\b15\b/);
    expect(server.closed).toBe(true);
    expect(server.child?.signalCode).toBe("SIGKILL");
  });

  it("handles broken stdin without an uncaught error and awaits cleanup", async () => {
    const server = nodeProcessAdapter("setInterval(() => {}, 1000);", true);
    await expect(createQuotaReader(server.adapter)("codex", context)).rejects.toThrow(Error);
    expect(server.closed).toBe(true);
  });

  it("reports a missing codex without reading real configuration", async () => {
    const root = makeRoot();
    await expect(
      createQuotaReader()("codex", { cwd: root, env: { HOME: root, PATH: root } }),
    ).rejects.toThrow(Error);
  });
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
    ).toContain("time-100");
  });

  it.each([undefined, null, "codex"])(
    "accepts legacy Codex identity %s and unknown metadata",
    (limitId) => {
      expect(() =>
        formatCodexQuota({ rateLimits: { limitId, primary: { usedPercent: 50 } } }),
      ).not.toThrow();
    },
  );

  it.each([
    { rateLimits: { limitId: "spark", primary: { usedPercent: 10 } } },
    { rateLimitsByLimitId: { codex: { limitId: "spark", primary: { usedPercent: 10 } } } },
  ])("rejects contradictory non-Codex identities", (response) => {
    expect(() => formatCodexQuota(response)).toThrow(Error);
  });

  it.each([null, { primary: { usedPercent: -1 } }])(
    "does not fall back from a present malformed authoritative snapshot",
    (codex) => {
      expect(() =>
        formatCodexQuota({
          rateLimits: { primary: { usedPercent: 10 } },
          rateLimitsByLimitId: { codex },
        }),
      ).toThrow(Error);
    },
  );

  it.each([
    { usedPercent: Number.NaN },
    { usedPercent: 101 },
    { usedPercent: "50" },
    { usedPercent: 10, windowDurationMins: 0 },
    { usedPercent: 10, resetsAt: -1 },
    { usedPercent: 10, resetsAt: 8_640_000_000_001 },
    { usedPercent: 10, resetsAt: "100" },
  ])("discards malformed windows but preserves valid remaining windows: %j", (primary) => {
    expect(() => formatCodexQuota({ rateLimits: { primary } })).toThrow(Error);
    expect(() =>
      formatCodexQuota({
        rateLimits: { primary, secondary: { usedPercent: 0, windowDurationMins: 1440 } },
      }),
    ).not.toThrow();
  });

  it("retains null/absent duration and reset, accepts the full valid percentage range", () => {
    const output = formatCodexQuota(
      {
        rateLimits: {
          primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null },
          secondary: { usedPercent: 100, resetsAt: 0 },
        },
      },
      (timestamp) => `time-${timestamp}`,
    );
    expect(output).toMatch(/\b0\b/);
    expect(output).toMatch(/\b100\b/);
    expect(output).toContain("time-0");
  });

  it("accepts valid Date timestamp boundaries without throwing from Intl", () => {
    expect(() =>
      formatCodexQuota({
        rateLimits: { primary: { usedPercent: 1, resetsAt: 8_640_000_000_000 } },
      }),
    ).not.toThrow();
  });

  it.each([{}, { rateLimitsByLimitId: { spark: { primary: { usedPercent: 10 } } } }])(
    "rejects missing windows without discovering another bucket",
    (response) => {
      expect(() => formatCodexQuota(response)).toThrow(Error);
    },
  );
});

describe("Antigravity quota", () => {
  const WEEKLY_RESET = Date.UTC(2026, 11, 2, 7, 28, 6) / 1000;
  const FIVE_HOUR_RESET = Date.UTC(2026, 10, 25, 12, 28, 6) / 1000;

  it("reads the usage command of agy in its JSON output", async () => {
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(agyUsage(groupA())) }));
    const reader = createQuotaReader({
      execute,
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    });
    const env = { KEEP: "yes" };
    await expect(reader("agy", { cwd: "/project", env })).resolves.toContain("Model group A");
    expect(execute).toHaveBeenCalledWith(
      "agy",
      ["-p", "/usage", "--output-format", "json"],
      expect.objectContaining({ cwd: "/project", env }),
    );
  });

  it("reports each valid bucket's used percentage, window and reset, per group", () => {
    const output = formatAgyQuota(
      JSON.stringify(
        agyUsage(groupA(), {
          name: "Model group B",
          buckets: [
            { id: "b-weekly", window: "weekly", remaining_fraction: 0.75, reset_time: "soon" },
            { id: "b-bad", window: "daily", remaining_fraction: 1.5, reset_time: "soon" },
          ],
        }),
      ),
      (timestamp) => `time-${timestamp}`,
    );
    expect(output).toContain("Model group A");
    expect(output).toContain("Model group B");
    expect(output).toMatch(new RegExp(`^.*1 week: 0% used\\b.*time-${WEEKLY_RESET}$`, "m"));
    expect(output).toMatch(new RegExp(`^.*5 hours: 1% used\\b.*time-${FIVE_HOUR_RESET}$`, "m"));
    expect(output).toMatch(/^.*1 week: 25% used\b/m);
    expect(output).not.toMatch(/25% used.*time-/);
    expect(output).not.toContain("daily");
  });

  it.each([
    "nope",
    JSON.stringify(
      agyUsage({
        name: "Model group A",
        buckets: [{ id: "a-weekly", window: "weekly", remaining_fraction: -0.1 }],
      }),
    ),
  ])("fails without any valid bucket: %s", (stdout) => {
    expect(() => formatAgyQuota(stdout)).toThrow(Error);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aligndev-quota-"));
  roots.push(root);
  return root;
}

// The fake comes first; the shell utilities stay reachable.
function fixtureEnv(root: string): NodeJS.ProcessEnv {
  return { HOME: root, PATH: `${root}:${process.env.PATH ?? ""}` };
}

function agyUsage(...groups: object[]): object {
  return { status: "SUCCESS", command: { name: "usage", data: { groups } } };
}

function groupA(): object {
  return {
    name: "Model group A",
    buckets: [
      {
        id: "a-weekly",
        window: "weekly",
        remaining_fraction: 0.998,
        reset_time: "2026-12-02T07:28:06Z",
      },
      {
        id: "a-5h",
        window: "5h",
        remaining_fraction: 0.993,
        reset_time: "2026-11-25T12:28:06Z",
      },
    ],
  };
}

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
