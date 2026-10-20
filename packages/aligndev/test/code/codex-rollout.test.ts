import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assessCodexState,
  createCodexState,
  interpretCodexLine,
} from "../../src/code/codex-agent.js";
import { readCodexContext } from "../../src/code/codex-rollout.js";
import { buildAgentEnv } from "../../src/code/run-agent.js";

const THREAD = "isolated-home-thread";
const TOTAL = 1000;

let root: string;
let parentHome: string;
let childHome: string;

describe("Codex rollout child HOME isolation", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aligndev-rollout-isolation-"));
    parentHome = join(root, "parent");
    childHome = join(root, "child");
    writeRollout(join(parentHome, ".codex"), 80);
    writeRollout(join(childHome, ".codex"), 240);
    vi.stubEnv("HOME", parentHome);
    vi.stubEnv("USERPROFILE", parentHome);
    vi.stubEnv("CODEX_HOME", join(parentHome, ".codex"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the finalized child's HOME rather than any parent native store", () => {
    const env = buildAgentEnv(process.env, ["CODEX_HOME", "USERPROFILE"], { HOME: childHome });
    expect(readCodexContext(THREAD, TOTAL, env).contextTokens).toBe(240);
  });

  it("uses the finalized child's USERPROFILE when HOME was removed", () => {
    const env = buildAgentEnv(process.env, ["CODEX_HOME", "HOME"], { USERPROFILE: childHome });
    expect(readCodexContext(THREAD, TOTAL, env).contextTokens).toBe(240);
  });

  it("keeps explicit child CODEX_HOME authoritative without a child HOME", () => {
    const nativeHome = join(root, "explicit-codex");
    writeRollout(nativeHome, 560);
    const env = buildAgentEnv(process.env, ["HOME", "USERPROFILE"], { CODEX_HOME: nativeHome });
    expect(readCodexContext(THREAD, TOTAL, env).contextTokens).toBe(560);
  });

  it("reports unavailable context when the child removed every native-home selector", () => {
    const env = buildAgentEnv(process.env, ["CODEX_HOME", "HOME", "USERPROFILE"], {});
    expect(readCodexContext(THREAD, TOTAL, env)).toMatchObject({
      contextTokens: null,
      compacted: false,
      error: expect.stringMatching(/native home is unavailable in the child environment/),
    });
    const state = createCodexState({
      prompt: "fixture",
      sessionFilePath: join(root, "unused.md"),
      cwd: childHome,
      executableModel: undefined,
      skipPermissions: false,
      additionalDirectories: [],
      env,
    });
    interpretCodexLine(JSON.stringify({ type: "thread.started", thread_id: THREAD }), state);
    interpretCodexLine(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: TOTAL } }),
      state,
    );
    expect(assessCodexState(state)).toMatchObject({
      contextTokensError: expect.stringMatching(/native home is unavailable/),
    });
    expect(assessCodexState(state).contextTokens).toBeUndefined();
  });

  it("never defaults an omitted or empty environment to the caller's HOME", () => {
    for (const reading of [readCodexContext(THREAD, TOTAL), readCodexContext(THREAD, TOTAL, {})]) {
      expect(reading.contextTokens).toBeNull();
      expect(reading.error).toMatch(/native home is unavailable/);
    }
  });

  it("does not search the parent when the child's isolated store has no rollout", () => {
    expect(readCodexContext(THREAD, TOTAL, { HOME: join(root, "empty-child") })).toMatchObject({
      contextTokens: null,
      error: expect.stringMatching(/No Codex rollout found/),
    });
  });
});

function writeRollout(nativeHome: string, occupancy: number): void {
  const directory = join(nativeHome, "sessions", "2026", "10", "19");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rollout-fixture-${THREAD}.jsonl`),
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: occupancy },
          total_token_usage: { input_tokens: TOTAL },
        },
      },
    })}\n`,
  );
}
