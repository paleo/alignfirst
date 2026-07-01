import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTranscript,
  applyCompletion,
  assertPlansGate,
  type LogFrontmatter,
  parseFrontmatter,
  readCompletion,
  resolveLogPath,
  serializeFrontmatter,
  writeInitialLog,
} from "../src/log-file.js";

const FIXED_DATE = new Date(2026, 6, 1, 9, 15, 3); // local 2026-07-01 09:15:03

describe("assertPlansGate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcoach-gate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when a .plans directory exists", () => {
    mkdirSync(join(dir, ".plans"));
    expect(assertPlansGate(dir)).toBeUndefined();
  });

  it("returns guidance when .plans is absent", () => {
    expect(assertPlansGate(dir)).toContain("no `.plans/` directory");
  });
});

describe("resolveLogPath", () => {
  it("uses the ticket coding-sessions directory", () => {
    const path = resolveLogPath("/proj", "29", FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "29", "coding-sessions", "20260701-091503.md"));
  });

  it("uses _coding-sessions without a ticket", () => {
    const path = resolveLogPath("/proj", undefined, FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "_coding-sessions", "20260701-091503.md"));
  });

  it("appends a numeric suffix on same-second collisions", () => {
    const taken = new Set([
      join("/proj", ".plans", "29", "coding-sessions", "20260701-091503.md"),
      join("/proj", ".plans", "29", "coding-sessions", "20260701-091503-2.md"),
    ]);
    const path = resolveLogPath("/proj", "29", FIXED_DATE, (p) => taken.has(p));
    expect(path).toBe(join("/proj", ".plans", "29", "coding-sessions", "20260701-091503-3.md"));
  });
});

describe("frontmatter serialization", () => {
  const frontmatter: LogFrontmatter = {
    status: "running",
    protocol: "spec",
    ticket: "29",
    model: null,
    sessionId: null,
    command: 'alcoach --new --protocol spec --ticket 29 --message "do: it"',
    startedAt: "2026-07-01T09:15:03.000Z",
    endedAt: null,
    exitReason: null,
  };

  it("round-trips through parseFrontmatter", () => {
    const block = serializeFrontmatter(frontmatter)
      .replace(/^---\n/, "")
      .replace(/\n---\n$/, "");
    expect(parseFrontmatter(block)).toEqual(frontmatter);
  });
});

describe("log lifecycle", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcoach-log-"));
    logPath = join(dir, "session.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a running header and completes to succeeded with a result", () => {
    const header: LogFrontmatter = {
      status: "running",
      protocol: "spec",
      ticket: "29",
      model: null,
      sessionId: null,
      command: "alcoach --new --protocol spec --ticket 29",
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
    };
    const length = writeInitialLog(logPath, header);
    expect(length).toBeGreaterThan(0);
    expect(existsSync(logPath)).toBe(true);

    appendTranscript(logPath, "[init] session abc\n");
    appendTranscript(logPath, "some assistant text\n");

    applyCompletion(logPath, {
      status: "succeeded",
      endedAt: "2026-07-01T09:41:20.000Z",
      exitReason: "completed",
      sessionId: "abc",
      result: "All done.",
    });

    const completion = readCompletion(logPath);
    expect(completion.frontmatter.status).toBe("succeeded");
    expect(completion.frontmatter.sessionId).toBe("abc");
    expect(completion.frontmatter.endedAt).toBe("2026-07-01T09:41:20.000Z");
    expect(completion.result).toBe("All done.");
  });

  it("records a failed completion", () => {
    writeInitialLog(logPath, {
      status: "running",
      protocol: null,
      ticket: null,
      model: null,
      sessionId: null,
      command: "alcoach --new --message hi",
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
    });
    applyCompletion(logPath, {
      status: "failed",
      endedAt: "2026-07-01T09:16:00.000Z",
      exitReason: "error",
      sessionId: null,
      result: "boom",
    });
    const completion = readCompletion(logPath);
    expect(completion.frontmatter.status).toBe("failed");
    expect(completion.frontmatter.exitReason).toBe("error");
    expect(completion.result).toBe("boom");
  });
});
