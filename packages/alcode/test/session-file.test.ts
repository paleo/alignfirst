import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTranscript,
  applyCompletion,
  assertPlansGate,
  type SessionFrontmatter,
  parseFrontmatter,
  readCompletion,
  resolveSessionFilePath,
  serializeFrontmatter,
  writeInitialSessionFile,
} from "../src/session-file.js";

const FIXED_DATE = new Date(2026, 6, 1, 9, 15, 3); // local 2026-07-01 09:15:03

describe("assertPlansGate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-gate-"));
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

describe("resolveSessionFilePath", () => {
  it("uses the ticket coding-sessions directory", () => {
    const path = resolveSessionFilePath("/proj", "29", FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "29", "coding-sessions", "20260701-091503.md"));
  });

  it("uses _coding-sessions without a ticket", () => {
    const path = resolveSessionFilePath("/proj", undefined, FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "_coding-sessions", "20260701-091503.md"));
  });

  it("appends a numeric suffix on same-second collisions", () => {
    const taken = new Set([
      join("/proj", ".plans", "29", "coding-sessions", "20260701-091503.md"),
      join("/proj", ".plans", "29", "coding-sessions", "20260701-091503-2.md"),
    ]);
    const path = resolveSessionFilePath("/proj", "29", FIXED_DATE, (p) => taken.has(p));
    expect(path).toBe(join("/proj", ".plans", "29", "coding-sessions", "20260701-091503-3.md"));
  });
});

describe("frontmatter serialization", () => {
  const frontmatter: SessionFrontmatter = {
    status: "running",
    protocol: "spec",
    ticket: "29",
    model: null,
    sessionId: null,
    command: 'alcode --new --protocol spec --ticket 29 --message "do: it"',
    meta: "thread:room-1/abc.def",
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

  it("keeps a malformed quoted value as raw text instead of throwing", () => {
    // A partially-written file may hold an unterminated quoted value; parsing must not crash.
    const parsed = parseFrontmatter('status: running\ncommand: "unterminated');
    expect(parsed.status).toBe("running");
    expect(parsed.command).toBe('"unterminated');
  });
});

describe("session file lifecycle", () => {
  let dir: string;
  let sessionFilePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-session-"));
    sessionFilePath = join(dir, "session.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a running header and completes to succeeded with a result", () => {
    const header: SessionFrontmatter = {
      status: "running",
      protocol: "spec",
      ticket: "29",
      model: null,
      sessionId: null,
      command: "alcode --new --protocol spec --ticket 29",
      meta: null,
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
    };
    writeInitialSessionFile(sessionFilePath, header);
    expect(existsSync(sessionFilePath)).toBe(true);

    appendTranscript(sessionFilePath, "[init] session abc\n");
    appendTranscript(sessionFilePath, "some assistant text\n");

    applyCompletion(sessionFilePath, {
      status: "succeeded",
      endedAt: "2026-07-01T09:41:20.000Z",
      exitReason: "completed",
      sessionId: "abc",
      result: "All done.",
    });

    const completion = readCompletion(sessionFilePath);
    expect(completion.frontmatter.status).toBe("succeeded");
    expect(completion.frontmatter.sessionId).toBe("abc");
    expect(completion.frontmatter.endedAt).toBe("2026-07-01T09:41:20.000Z");
    expect(completion.result).toBe("All done.");
  });

  it("records a failed completion", () => {
    writeInitialSessionFile(sessionFilePath, {
      status: "running",
      protocol: null,
      ticket: null,
      model: null,
      sessionId: null,
      command: "alcode --new --message hi",
      meta: null,
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
    });
    applyCompletion(sessionFilePath, {
      status: "failed",
      endedAt: "2026-07-01T09:16:00.000Z",
      exitReason: "error",
      sessionId: null,
      result: "boom",
    });
    const completion = readCompletion(sessionFilePath);
    expect(completion.frontmatter.status).toBe("failed");
    expect(completion.frontmatter.exitReason).toBe("error");
    expect(completion.result).toBe("boom");
  });

  it("reads the terminal result even when the transcript echoes the result marker", () => {
    writeInitialSessionFile(sessionFilePath, {
      status: "running",
      protocol: "aad",
      ticket: "29",
      model: null,
      sessionId: null,
      command: "alcode --new --protocol aad --ticket 29 --message go",
      meta: null,
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
    });
    // The agent echoes a whole session file into the transcript, spurious marker and all.
    appendTranscript(sessionFilePath, "here is a session file:\n---- Result ----\nold junk\n");
    applyCompletion(sessionFilePath, {
      status: "succeeded",
      endedAt: "2026-07-01T09:41:20.000Z",
      exitReason: "completed",
      sessionId: "abc",
      result: "the real result",
    });
    expect(readCompletion(sessionFilePath).result).toBe("the real result");
  });
});
