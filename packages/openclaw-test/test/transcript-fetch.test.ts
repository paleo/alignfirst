import { readFileSync, rmSync } from "node:fs";
import { getQaBusState } from "@alignfirst/openclaw-channel-mock-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execInGateway } from "../src/exec-rpc.js";
import { fetchTranscriptSnapshot } from "../src/transcript-log.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn(), rmSync: vi.fn() }));
vi.mock("@alignfirst/openclaw-channel-mock-core", () => ({ getQaBusState: vi.fn() }));
vi.mock("../src/exec-rpc.js", () => ({
  IPC_DIR: "/test-ipc",
  execInGateway: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("fetchTranscriptSnapshot", () => {
  it.each(["C-Run-1", "c-run-1"])(
    "includes bus-owned threads regardless of conversation ID casing: %s",
    async (conversationId) => {
      const startedAtIso = "2026-09-10T10:00:00.000Z";
      const snapshot = { databases: 1, sessions: [] };
      vi.mocked(getQaBusState).mockResolvedValue({
        cursor: 0,
        conversations: [],
        messages: [],
        events: [],
        threads: [
          { id: "thread-upper", conversationId: "C-RUN-1" },
          { id: "thread-lower", conversationId: "c-run-1" },
          { id: "thread-other", conversationId: "C-RUN-10" },
        ].map((thread) => ({
          ...thread,
          accountId: "default",
          title: "Work",
          createdAt: 0,
          createdBy: "agent",
        })),
      });
      vi.mocked(execInGateway).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(snapshot));

      await expect(fetchTranscriptSnapshot({ conversationId, startedAtIso })).resolves.toEqual(
        snapshot,
      );

      const outPath = expect.stringMatching(/^\/test-ipc\/[^/]+\.transcript\.json$/);
      expect(execInGateway).toHaveBeenCalledExactlyOnceWith(
        [
          "node",
          "/opt/openclaw-test/src/dist/transcript-dump.js",
          startedAtIso,
          conversationId,
          outPath,
          "thread-upper",
          "thread-lower",
        ],
        { timeoutMs: 60_000 },
      );
      expect(readFileSync).toHaveBeenCalledWith(outPath, "utf8");
      expect(rmSync).toHaveBeenCalledWith(outPath, { force: true });
    },
  );
});
