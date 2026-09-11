import { spawn } from "node:child_process";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { HandoffRecord } from "./types.js";

const STDERR_TAIL_BYTES = 2_048;
const CLIENT_TIMEOUT_MARGIN_MS = 30_000;
const MAX_CLIENT_TIMEOUT_MS = 2_147_483_647;

export interface SeedTurnParams {
  record: HandoffRecord;
  seed: string;
  turnTimeoutSeconds: number;
}

export interface SeedTurnResult {
  exitCode: number | null;
  stderrTail: string;
}

export function runSeedTurn(params: SeedTurnParams): Promise<SeedTurnResult> {
  const gatewayParams = buildSeedTurnParams(params.record, params.seed, params.turnTimeoutSeconds);
  const clientTimeoutMs =
    params.turnTimeoutSeconds === 0
      ? MAX_CLIENT_TIMEOUT_MS
      : params.turnTimeoutSeconds * 1_000 + CLIENT_TIMEOUT_MARGIN_MS;
  return new Promise((resolve) => {
    const child = spawn(
      "openclaw",
      [
        "gateway",
        "call",
        "agent",
        "--params",
        JSON.stringify(gatewayParams),
        "--expect-final",
        "--timeout",
        String(clientTimeoutMs),
      ],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (error) => resolve({ exitCode: null, stderrTail: error.message }));
    child.once("exit", (exitCode) => resolve({ exitCode, stderrTail }));
  });
}

export function buildSeedTurnParams(
  record: HandoffRecord,
  seed: string,
  turnTimeoutSeconds: number,
): Record<string, unknown> {
  return {
    message: seed,
    sessionKey: record.targetSessionKey,
    agentId: record.agentId,
    deliver: true,
    replyChannel: record.deliveryContext.channel,
    replyTo: record.deliveryContext.to,
    ...(record.deliveryContext.accountId
      ? { replyAccountId: record.deliveryContext.accountId }
      : {}),
    ...(record.deliveryContext.threadId ? { threadId: record.deliveryContext.threadId } : {}),
    timeout: turnTimeoutSeconds,
    idempotencyKey: `thread-handoff:${record.handoffId}:${record.attemptCount}`,
  };
}

export function resolveTurnTimeoutSeconds(runtime: OpenClawPluginApi["runtime"]): number {
  const cfg = runtime.config.current();
  if (cfg.agents?.defaults?.timeoutSeconds === 0) return 0;
  return Math.ceil(
    runtime.agent.resolveAgentTimeoutMs({
      // The resolver only reads configuration; the runtime exposes the same shape as readonly.
      cfg: cfg as OpenClawConfig,
    }) / 1_000,
  );
}
