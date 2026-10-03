import { copyFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execInGateway } from "../src/exec-rpc.js";
import { archiveGatewayLog } from "../src/gateway-log.js";

vi.mock("node:fs", () => ({ copyFileSync: vi.fn(), rmSync: vi.fn() }));
vi.mock("../src/exec-rpc.js", () => ({
  IPC_DIR: "/test-ipc",
  execInGateway: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("archiveGatewayLog", () => {
  it("copies the gateway's file log into the artifact dir through the IPC volume", async () => {
    vi.mocked(execInGateway).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await archiveGatewayLog("/artifacts/cell");

    const ipcPath = expect.stringMatching(/^\/test-ipc\/[^/]+\.gateway\.log$/);
    expect(execInGateway).toHaveBeenCalledExactlyOnceWith([
      "sh",
      "-c",
      'cat /tmp/openclaw/openclaw-*.log > "$1"',
      "sh",
      ipcPath,
    ]);
    expect(copyFileSync).toHaveBeenCalledExactlyOnceWith(ipcPath, "/artifacts/cell/gateway.log");
    expect(rmSync).toHaveBeenCalledWith(ipcPath, { force: true });
  });

  it("reports a failed copy without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execInGateway).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "cat: can't open '/tmp/openclaw/openclaw-*.log'",
    });

    await expect(archiveGatewayLog("/artifacts/cell")).resolves.toBeUndefined();

    expect(copyFileSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway log copy failed (exit 1)"));
    expect(rmSync).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
