import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTranscript,
  applyCompletion,
  assertPlansGate,
  type SessionFrontmatter,
  listSessionRecords,
  parseFrontmatter,
  readCompletion,
  readPidStartTime,
  reconcileSessionFile,
  reserveSideTicket,
  resolveSessionFilePath,
  serializeFrontmatter,
  writeInitialSessionFile,
} from "../src/session-file.js";

const FIXED_DATE = new Date(2026, 6, 1, 9, 15, 3); // local 2026-07-01 09:15:03

function makeFrontmatter(overrides?: Partial<SessionFrontmatter>): SessionFrontmatter {
  return {
    status: "running",
    agent: "claude",
    protocol: "spec",
    ticket: "29",
    model: null,
    sessionId: null,
    command: "alcode new --protocol spec --ticket 29",
    meta: null,
    pid: null,
    pidStartTime: null,
    cwd: null,
    startedAt: "2026-07-01T09:15:03.000Z",
    endedAt: null,
    exitReason: null,
    ...overrides,
  };
}

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
  it("uses the ticket _alcode directory", () => {
    const path = resolveSessionFilePath("/proj", "29", FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "29", "_alcode", "20260701-091503.md"));
  });

  it("uses the root _alcode directory without a ticket", () => {
    const path = resolveSessionFilePath("/proj", undefined, FIXED_DATE, () => false);
    expect(path).toBe(join("/proj", ".plans", "_alcode", "20260701-091503.md"));
  });

  it("appends a numeric suffix on same-second collisions", () => {
    const taken = new Set([
      join("/proj", ".plans", "29", "_alcode", "20260701-091503.md"),
      join("/proj", ".plans", "29", "_alcode", "20260701-091503-2.md"),
    ]);
    const path = resolveSessionFilePath("/proj", "29", FIXED_DATE, (p) => taken.has(p));
    expect(path).toBe(join("/proj", ".plans", "29", "_alcode", "20260701-091503-3.md"));
  });
});

describe("frontmatter serialization", () => {
  const frontmatter = makeFrontmatter({
    command: 'alcode new --protocol spec --ticket 29 --message "do: it"',
    meta: "thread:room-1/abc.def",
    pid: 12345,
    pidStartTime: "98765",
    cwd: "/home/user/proj",
  });

  it("round-trips through parseFrontmatter", () => {
    const block = serializeFrontmatter(frontmatter)
      .replace(/^---\n/, "")
      .replace(/\n---\n$/, "");
    expect(parseFrontmatter(block)).toEqual(frontmatter);
  });

  it("round-trips null pid and cwd", () => {
    const block = serializeFrontmatter(makeFrontmatter())
      .replace(/^---\n/, "")
      .replace(/\n---\n$/, "");
    const parsed = parseFrontmatter(block);
    expect(parsed.pid).toBeNull();
    expect(parsed.cwd).toBeNull();
  });

  it("parses an omitted legacy agent as null", () => {
    expect(parseFrontmatter("status: succeeded").agent).toBeNull();
  });

  it("parses an invalid or absent pid as null", () => {
    expect(parseFrontmatter("status: running\npid: not-a-number").pid).toBeNull();
    expect(parseFrontmatter("status: running\npid: -1").pid).toBeNull();
    expect(parseFrontmatter("status: running\npid: 1.5").pid).toBeNull();
    expect(parseFrontmatter("status: running").pid).toBeNull();
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
    writeInitialSessionFile(sessionFilePath, makeFrontmatter({ pid: 4242, cwd: "/proj" }));
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
    expect(completion.frontmatter.agent).toBe("claude");
    expect(completion.frontmatter.sessionId).toBe("abc");
    expect(completion.frontmatter.endedAt).toBe("2026-07-01T09:41:20.000Z");
    expect(completion.frontmatter.pid).toBe(4242);
    expect(completion.frontmatter.cwd).toBe("/proj");
    expect(completion.result).toBe("All done.");
  });

  it("records a failed completion", () => {
    writeInitialSessionFile(
      sessionFilePath,
      makeFrontmatter({ protocol: null, ticket: null, command: "alcode new --message hi" }),
    );
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

  it("reconciles a dead running process without waiting for another run", () => {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    writeInitialSessionFile(sessionFilePath, makeFrontmatter({ pid: child.pid }));

    const completion = reconcileSessionFile(sessionFilePath, FIXED_DATE);

    expect(completion.frontmatter.status).toBe("failed");
    expect(completion.frontmatter.endedAt).toBe(FIXED_DATE.toISOString());
    expect(completion.frontmatter.exitReason).toBe("terminated");
    expect(completion.result).toContain("is gone");
  });

  it("detects pid reuse when Linux process start time differs", () => {
    const currentStartTime = readPidStartTime(process.pid);
    if (currentStartTime === null) return;
    writeInitialSessionFile(
      sessionFilePath,
      makeFrontmatter({ pid: process.pid, pidStartTime: `${currentStartTime}-other` }),
    );

    expect(reconcileSessionFile(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("reads the terminal result even when the transcript echoes the result marker", () => {
    writeInitialSessionFile(
      sessionFilePath,
      makeFrontmatter({
        protocol: "aad",
        command: "alcode new --protocol aad --ticket 29 --message go",
      }),
    );
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

describe("reserveSideTicket", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-side-"));
    mkdirSync(join(dir, ".plans"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts at side-1 and creates the directory", () => {
    expect(reserveSideTicket(dir)).toBe("side-1");
    expect(existsSync(join(dir, ".plans", "side-1"))).toBe(true);
  });

  it("takes one above the highest side-N directory, ignoring other names", () => {
    mkdirSync(join(dir, ".plans", "side-1"));
    mkdirSync(join(dir, ".plans", "side-3"));
    mkdirSync(join(dir, ".plans", "side-notes"));
    mkdirSync(join(dir, ".plans", "42"));
    expect(reserveSideTicket(dir)).toBe("side-4");
  });

  it("takes one above the highest archived side ticket", () => {
    mkdirSync(join(dir, ".plans", "side-1"));
    mkdirSync(join(dir, ".plans", "_archives", "side-5"), { recursive: true });
    mkdirSync(join(dir, ".plans", "_archives", "side-5-2"));
    expect(reserveSideTicket(dir)).toBe("side-6");
    expect(existsSync(join(dir, ".plans", "side-6"))).toBe(true);
  });

  it("skips a candidate whose creation loses to an existing entry", () => {
    mkdirSync(join(dir, ".plans", "side-1"));
    writeFileSync(join(dir, ".plans", "side-2"), ""); // not a directory: invisible to the scan
    expect(reserveSideTicket(dir)).toBe("side-3");
    expect(existsSync(join(dir, ".plans", "side-3"))).toBe(true);
  });

  it("reserves consecutive ids on successive calls", () => {
    expect(reserveSideTicket(dir)).toBe("side-1");
    expect(reserveSideTicket(dir)).toBe("side-2");
  });
});

describe("listSessionRecords", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-records-"));
    mkdirSync(join(dir, ".plans"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedRecord(subdir: string, name: string, frontmatter: SessionFrontmatter): string {
    const path = join(dir, ".plans", subdir, name);
    writeInitialSessionFile(path, frontmatter);
    return path;
  }

  // A just-exited child's pid is guaranteed dead (and not yet reused).
  function deadPid(): number {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    return child.pid;
  }

  it("returns an empty list when .plans has no session directories", () => {
    expect(listSessionRecords(dir)).toEqual([]);
  });

  it("lists records from the root and ticket _alcode directories", () => {
    const rootPath = seedRecord("_alcode", "a.md", makeFrontmatter({ status: "succeeded" }));
    const ticketPath = seedRecord(
      join("29", "_alcode"),
      "b.md",
      makeFrontmatter({ status: "failed" }),
    );
    const records = listSessionRecords(dir);
    expect(records.map((r) => r.path).sort()).toEqual([rootPath, ticketPath].sort());
  });

  it("skips non-md files and files without a frontmatter block", () => {
    seedRecord("_alcode", "good.md", makeFrontmatter({ status: "succeeded" }));
    writeFileSync(join(dir, ".plans", "_alcode", "junk.md"), "no frontmatter here");
    writeFileSync(join(dir, ".plans", "_alcode", "notes.txt"), "---\nstatus: running\n---\n");
    const records = listSessionRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].frontmatter.status).toBe("succeeded");
  });

  it("seals a running record whose pid is dead", () => {
    const path = seedRecord("_alcode", "stale.md", makeFrontmatter({ pid: deadPid() }));
    const records = listSessionRecords(dir);
    expect(records[0].frontmatter.status).toBe("failed");
    expect(records[0].frontmatter.exitReason).toBe("terminated");
    const sealed = readCompletion(path);
    expect(sealed.frontmatter.status).toBe("failed");
    expect(sealed.frontmatter.exitReason).toBe("terminated");
    expect(sealed.frontmatter.agent).toBe("claude");
    expect(sealed.result).toContain("is gone");
  });

  it("seals a running record with no pid", () => {
    seedRecord("_alcode", "no-pid.md", makeFrontmatter());
    expect(listSessionRecords(dir)[0].frontmatter.status).toBe("failed");
  });

  it("leaves a running record with a live pid untouched", () => {
    const path = seedRecord("_alcode", "live.md", makeFrontmatter({ pid: process.pid }));
    const records = listSessionRecords(dir);
    expect(records[0].frontmatter.status).toBe("running");
    expect(readCompletion(path).frontmatter.status).toBe("running");
  });
});
