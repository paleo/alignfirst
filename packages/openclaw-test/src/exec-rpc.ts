import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const IPC_DIR = "/var/run/openclaw-test-ipc";
// Wait this much longer than the requested timeout before declaring the
// host-side poll dead. Gives the watcher time to kill the child on its own
// timeout (exitCode 124) and write the truncated response file.
const WATCHER_DEADLINE_HEADROOM_MS = 5_000;
const EXEC_POLL_INTERVAL_MS = 100;
const WATCHER_TIMEOUT_EXIT_CODE = 124;

export interface ExecInGatewayOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ExecInGatewayResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execInGateway(
  argv: string[],
  opts: ExecInGatewayOptions = {},
): Promise<ExecInGatewayResult> {
  const id = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const payload: Record<string, unknown> = { id, argv, timeoutMs };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  if (opts.env !== undefined) payload.env = opts.env;
  if (opts.stdin !== undefined) payload.stdin = opts.stdin;
  const reqPath = `${IPC_DIR}/${id}.req.json`;
  const reqTmp = `${reqPath}.tmp`;
  const resPath = `${IPC_DIR}/${id}.res.json`;
  writeFileSync(reqTmp, JSON.stringify(payload));
  renameSync(reqTmp, reqPath);
  const deadline = Date.now() + timeoutMs + WATCHER_DEADLINE_HEADROOM_MS;
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      const raw = readFileSync(resPath, "utf8");
      rmSync(resPath, { force: true });
      rmSync(reqPath, { force: true });
      const parsed = JSON.parse(raw) as ExecInGatewayResult;
      if (parsed.exitCode === WATCHER_TIMEOUT_EXIT_CODE) {
        console.warn(
          `execInGateway: watcher killed child after ${timeoutMs}ms (id ${id}, argv ${JSON.stringify(argv)})`,
        );
      }
      return parsed;
    }
    await new Promise((r) => setTimeout(r, EXEC_POLL_INTERVAL_MS));
  }
  rmSync(reqPath, { force: true });
  throw new Error(`execInGateway timed out waiting for response (request id ${id})`);
}
