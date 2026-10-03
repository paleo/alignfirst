import { randomUUID } from "node:crypto";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execInGateway, IPC_DIR } from "./exec-rpc.js";

// OpenClaw's rolling file log, `openclaw-<date>.log` under its temp root. It lives in
// the gateway container, which the per-cell stack recreation destroys. Provider
// failures such as an HTTP 401 are recorded there and nowhere in the transcripts.
const GATEWAY_LOG_GLOB = "/tmp/openclaw/openclaw-*.log";

/**
 * Copies the gateway's file log into the cell's artifact dir as `gateway.log`.
 * Under `--reuse-stack` the gateway outlives the cell, so the copy also holds
 * earlier cells' lines. Best-effort: a failure is reported, never fatal.
 */
export async function archiveGatewayLog(outDir: string): Promise<void> {
  const ipcPath = `${IPC_DIR}/${randomUUID()}.gateway.log`;
  try {
    const result = await execInGateway([
      "sh",
      "-c",
      `cat ${GATEWAY_LOG_GLOB} > "$1"`,
      "sh",
      ipcPath,
    ]);
    if (result.exitCode !== 0) {
      console.warn(
        `openclaw-test: gateway log copy failed (exit ${result.exitCode}): ${result.stderr}`,
      );
      return;
    }
    copyFileSync(ipcPath, join(outDir, "gateway.log"));
  } catch (err) {
    console.warn(`openclaw-test: gateway log copy failed: ${String(err)}`);
  } finally {
    rmSync(ipcPath, { force: true });
  }
}
