import { readFileSync } from "node:fs";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH ?? "/home/kclaw/.openclaw/openclaw.json";

type AgentEntry = {
  id: string;
  name?: string;
  model: string;
  workspace?: string;
  tools?: unknown;
};

type OpenClawConfig = {
  agents: { list: AgentEntry[] };
  channels?: Record<string, unknown>;
};

function loadConfig(): OpenClawConfig {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as OpenClawConfig;
}

export function readJudgeConfig(): AgentEntry {
  const cfg = loadConfig();
  const judge = cfg.agents.list.find((a) => a.id === "judge");
  if (!judge) throw new Error(`No agent id="judge" in ${CONFIG_PATH}`);
  return judge;
}
