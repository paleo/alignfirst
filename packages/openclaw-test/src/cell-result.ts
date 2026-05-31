import { readFileSync, writeFileSync } from "node:fs";
import type { JudgeUsage } from "./judge.js";

export interface CellResult {
  schemaVersion: 3;
  scenarioId: string;
  channel: string;
  model: string;
  iterationIndex: number;
  verdict: "pass" | "fail";
  durationMs: number;
  conversationId: string;
  artifactDirName: string;
  agentCostUsd: number;
  agentTurns: number;
  judgeUsd: number;
  judgeUsages: JudgeUsage[];
}

export function readCellResult(path: string): CellResult | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const r = parsed as { schemaVersion?: unknown };
  if (r.schemaVersion !== 3) return undefined;
  return parsed as CellResult;
}

export function writeCellResult(path: string, r: CellResult): void {
  writeFileSync(path, JSON.stringify(r, null, 2));
}
