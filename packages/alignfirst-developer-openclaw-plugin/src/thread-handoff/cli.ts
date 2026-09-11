import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createHandoffStore, type HandoffStore } from "./state.js";
import type { DeliveryReceipt, HandoffRecord } from "./types.js";
import { WAKE_METHOD, type WakeResult } from "./wake.js";

const CLIENT_TIMEOUT_MARGIN_MS = 30_000;
const MAX_CLIENT_TIMEOUT_MS = 2_147_483_647;

export interface WakeCommandOptions extends GatewayRpcOpts {
  sessionKey: string;
  message: string;
}

export function registerThreadHandoffCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const command = program
        .command("thread-handoff")
        .description("Inspect and maintain durable thread handoffs");
      command
        .command("list")
        .description("List pending and claimed handoffs")
        .option("--json", "Print JSON")
        .action((options: { json?: boolean }) => listHandoffs(api, options.json === true));
      command
        .command("receipts")
        .description("List active delivery receipts")
        .option("--json", "Print JSON")
        .action((options: { json?: boolean }) => listReceipts(api, options.json === true));
      command
        .command("retire")
        .description("Retire one claimed handoff")
        .argument("<handoff-id>")
        .option("--force", "Also retire a pending handoff")
        .action((handoffId: string, options: { force?: boolean }) =>
          retireHandoff(api, handoffId, options.force === true),
        );
      addGatewayClientOptions(
        command
          .command("wake")
          .description("Start a reply run on a thread session with a message")
          .requiredOption("--session-key <key>", "Target thread session key")
          .requiredOption("--message <text>", "Message that starts the turn"),
      ).action(
        (
          options: WakeCommandOptions,
          wake: { getOptionValueSource(name: string): string | undefined },
        ) => wakeThreadSession(api, options, wake.getOptionValueSource("timeout") === "default"),
      );
    },
    {
      descriptors: [
        {
          name: "thread-handoff",
          description: "Inspect and maintain durable thread handoffs",
          hasSubcommands: true,
          machineOutput: ({ argv }) => argv.includes("--json"),
        },
      ],
    },
  );
}

export async function wakeThreadSession(
  api: OpenClawPluginApi,
  options: WakeCommandOptions,
  timeoutIsDefault: boolean,
): Promise<void> {
  const timeout = timeoutIsDefault
    ? String(resolveWakeClientTimeoutMs(api.runtime))
    : options.timeout;
  const result = await callGatewayFromCli(
    WAKE_METHOD,
    {
      url: options.url,
      port: options.port,
      token: options.token,
      password: options.password,
      timeout,
    },
    { sessionKey: options.sessionKey, message: options.message },
    { mode: "cli", scopes: ["operator.write", "operator.read"] },
  );
  if (!isWakeResult(result)) throw new Error("Invalid thread wake response from the gateway.");
  if (result.status === "failed") throw new Error(result.error);
  process.stdout.write("Thread wake completed.\n");
}

function resolveWakeClientTimeoutMs(runtime: OpenClawPluginApi["runtime"]): number {
  const cfg = runtime.config.current();
  if (cfg.agents?.defaults?.timeoutSeconds === 0) return MAX_CLIENT_TIMEOUT_MS;
  return (
    runtime.agent.resolveAgentTimeoutMs({
      // The resolver only reads configuration; the runtime exposes it as readonly.
      cfg: cfg as OpenClawConfig,
    }) + CLIENT_TIMEOUT_MARGIN_MS
  );
}

function isWakeResult(value: unknown): value is WakeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = Reflect.get(value, "status");
  return (
    status === "completed" ||
    (status === "failed" && typeof Reflect.get(value, "error") === "string")
  );
}

function listHandoffs(api: OpenClawPluginApi, json: boolean): void {
  withStore(api, (store) => {
    process.stdout.write(`${renderHandoffs(store.listHandoffs(), json)}\n`);
  });
}

export function renderHandoffs(records: HandoffRecord[], json: boolean): string {
  if (json) {
    const projected = records.map(({ starterText: _starterText, ...record }) => record);
    return JSON.stringify(projected, null, 2);
  }
  if (records.length === 0) return "No managed handoffs.";
  return records
    .map(
      (record) =>
        `${record.handoffId}\t${record.state}\t${record.attemptCount} attempts\t${record.targetSessionKey}\t${record.createdAt}`,
    )
    .join("\n");
}

function withStore<T>(api: OpenClawPluginApi, operation: (store: HandoffStore) => T): T {
  const store = createHandoffStore(api.runtime.state.resolveStateDir());
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function listReceipts(api: OpenClawPluginApi, json: boolean): void {
  withStore(api, (store) => {
    process.stdout.write(`${renderReceipts(store.listReceipts(Date.now()), json)}\n`);
  });
}

export function renderReceipts(receipts: DeliveryReceipt[], json: boolean): string {
  if (json) {
    const projected = receipts.map((receipt) => ({
      sessionKey: receipt.sessionKey,
      sessionId: receipt.sessionId,
      threadId: receipt.threadId,
      ...(receipt.starterMessageId ? { starterMessageId: receipt.starterMessageId } : {}),
      createdAt: receipt.createdAt,
      expiresAt: receipt.expiresAt,
    }));
    return JSON.stringify(projected, null, 2);
  }
  if (receipts.length === 0) return "No active receipts.";
  return receipts
    .map(
      (receipt) =>
        `${receipt.sessionKey}\t${receipt.threadId}\t${receipt.starterMessageId ?? "-"}\t${receipt.createdAt}\t${receipt.expiresAt}`,
    )
    .join("\n");
}

function retireHandoff(api: OpenClawPluginApi, handoffId: string, force: boolean): void {
  withStore(api, (store) => {
    const retired = store.retireHandoff(handoffId.trim(), { force });
    if (!retired) throw new Error(`Unknown handoff: ${handoffId}`);
    process.stdout.write(`Retired ${handoffId}.\n`);
  });
}
