import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const probe = fileURLToPath(new URL("./fixtures/settlement-probe.ts", import.meta.url));
const watchdog = fileURLToPath(new URL("./fixtures/settlement-watchdog.py", import.meta.url));

interface Observation {
  nativeVersion: string;
  requests: number;
  promptReturned: boolean;
  operationReturned: boolean;
  signalAtBoundary: boolean;
  toolSignalAborted: boolean;
  shutdowns: number;
  settlements: boolean[];
  errors: string[];
  workerPids: number[];
  continuationSawResult: boolean;
  held: Observation;
  beforeCleanup?: Observation;
  final?: string;
}

interface Report {
  evidence: Observation;
  watchdogKilled: boolean;
  returnCode: number;
  probePid: number;
  reaped: number[];
  remaining: number[];
  stdout: string;
  stderr: string;
}

// Linux subreaping makes even the deliberately wedged cases leave no orphan zombies.
describe.skipIf(process.platform !== "linux")("Pi 1.3.0 headless feasibility blocker", () => {
  it("calibrates event-driven waiting through process close and cleanup before one continuation", async () => {
    const report = await runProbe("control");
    expectHeld(report.evidence.held);
    expectHeld(report.evidence.beforeCleanup);
    expect(report.evidence).toMatchObject({
      requests: 3,
      promptReturned: true,
      continuationSawResult: true,
      settlements: [false],
      final: "authoritative result",
      errors: [],
    });
    expect(report.returnCode).toBe(0);
    expect(report.watchdogKilled).toBe(false);
  }, 20000);

  it.each(["abort", "new", "switch"])(
    "records public %s blocked at a held boundary without releasing its job",
    async (action) => {
      const report = await runProbe(action);
      expectHeld(report.evidence.held);
      expectHeld(report.evidence);
      expect(report.evidence).toMatchObject({
        operationReturned: false,
        signalAtBoundary: false,
        toolSignalAborted: false,
        shutdowns: 0,
        errors: [],
      });
      expect(report.watchdogKilled).toBe(true);
      expect(report.returnCode).toBe(-9);
      expect(report.reaped.sort()).toEqual([report.probePid, ...report.evidence.workerPids].sort());
    },
    20000,
  );

  it("records a swallowed cleanup failure followed by successful authoritative settlement", async () => {
    const report = await runProbe("failure");
    expectHeld(report.evidence.held);
    expect(report.evidence).toMatchObject({
      requests: 2,
      promptReturned: true,
      settlements: [false],
      final: "provisional",
      errors: ["Injected unresolved process cleanup failure"],
      shutdowns: 0,
      continuationSawResult: false,
    });
    expect(report.watchdogKilled).toBe(true);
    expect(report.reaped.sort()).toEqual([report.probePid, ...report.evidence.workerPids].sort());
  }, 20000);
});

async function runProbe(action: string): Promise<Report> {
  const directory = mkdtempSync(join(tmpdir(), "pi-settlement-probe-"));
  try {
    // The Python supervisor owns deadlines, SIGKILL and waitpid; never call host.close() here.
    const { stdout, stderr } = await execute(
      "python3",
      [watchdog, process.execPath, probe, action, directory],
      { maxBuffer: 128 * 1024 },
    );
    expect(stderr).toBe("");
    const report: Report = JSON.parse(stdout);
    expect(report.remaining).toEqual([]);
    expect(report.evidence.workerPids).toHaveLength(2);
    expect(report.stderr).toBe("");
    expect(report.evidence.nativeVersion).toBe("1.3.0");
    return report;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectHeld(observation: Observation | undefined) {
  expect(observation).toMatchObject({
    requests: 2,
    promptReturned: false,
    settlements: [],
    continuationSawResult: false,
  });
}
