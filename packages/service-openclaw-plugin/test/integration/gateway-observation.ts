import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ToolObservation {
  phase: "before" | "after";
  sessionKey: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result?: {
    details?: { status?: string; handoffId?: string; sessionKey?: string };
    content?: Array<{ text?: string }>;
  };
  error?: string;
}

export interface HandoffObservation {
  handoffId: string;
  state: string;
  threadId: string;
  targetSessionKey: string;
  channelId: string;
  parentConversationId: string;
  attemptCount: number;
  claimedBy?: { sessionId: string; runId?: string };
}

export function toolObservations(root: string): ToolObservation[] {
  const path = resolve(root, "tool-observations.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const event: ToolObservation = JSON.parse(line);
      for (const field of ["sessionKey", "sessionId", "runId", "toolCallId"] as const) {
        if (typeof event[field] !== "string" || event[field].length === 0) {
          throw new Error(`Tool observer missing ${field} for ${event.toolName}`);
        }
      }
      return event;
    });
}

export function observedClaims(root: string): ToolObservation[] {
  const events = toolObservations(root);
  const claims = events.filter(
    (event) =>
      event.phase === "after" &&
      event.toolName === "thread_handoff" &&
      event.params.action === "claim",
  );
  const identities = new Set<string>();
  for (const claim of claims) {
    const identity = toolIdentity(claim);
    if (identities.has(identity)) throw new Error(`Duplicate after-hook observation: ${identity}`);
    identities.add(identity);
    if (
      !events.some(
        (event) =>
          event.phase === "before" &&
          toolIdentity(event) === identity &&
          event.toolName === claim.toolName &&
          event.params.action === "claim",
      )
    ) {
      throw new Error(`Claim has no correlated before hook: ${identity}`);
    }
  }
  return claims;
}

export function claimStatus(claim: ToolObservation): string {
  if (claim.error !== undefined) return "error";
  const status = claim.result?.details?.status;
  if (typeof status !== "string")
    throw new Error(`Claim result missing status: ${toolIdentity(claim)}`);
  return status;
}

export function requireClaimOwnership(
  root: string,
  records: HandoffObservation[],
  claims = observedClaims(root),
): void {
  if (claims.length === 0) throw new Error("No hook-observed claim invocations");
  const starts = toolObservations(root).filter(
    (event) =>
      event.phase === "after" &&
      event.toolName === "thread_handoff" &&
      event.params.action === "start",
  );
  for (const record of records) {
    const target =
      record.channelId === "slack-mock"
        ? `agent:main:slack-mock:channel:${record.parentConversationId}:thread:${record.threadId}`
        : `agent:main:discord-mock:channel:${record.threadId}`;
    if (record.targetSessionKey !== target.toLowerCase())
      throw new Error(`Handoff has a noncanonical target: ${record.handoffId}`);
    if (
      !starts.some(
        (start) =>
          start.result?.details?.handoffId === record.handoffId &&
          start.result.details.sessionKey === record.targetSessionKey &&
          start.params.threadId === record.threadId &&
          start.error === undefined,
      )
    )
      throw new Error(`No matching real start result for ${record.handoffId}`);
    const current = claims.filter((claim) => claim.sessionKey === record.targetSessionKey);
    if (record.claimedBy?.runId === undefined)
      throw new Error(`Durable claim has no run identity: ${record.handoffId}`);
    const grants = current.filter((claim) => claimStatus(claim) === "claimed");
    if (grants.length === 0) throw new Error(`No observed grant for ${record.handoffId}`);
    for (const grant of grants) {
      const owner = record.claimedBy;
      if (!owner || grant.runId !== owner.runId || grant.sessionId !== owner.sessionId) {
        throw new Error(
          `Claim grant disagrees with durable owner of ${record.handoffId}: ${toolIdentity(grant)}`,
        );
      }
    }
    if (record.attemptCount < 1 || record.state !== "claimed") {
      throw new Error(`Claim has no durable attempted handoff: ${record.handoffId}`);
    }
    for (const claim of current) {
      if (claim.params.handoffId !== undefined && claim.params.handoffId !== record.handoffId)
        throw new Error(`Claim names a different handoff: ${record.handoffId}`);
      if (!["claimed", "alreadyClaimed"].includes(claimStatus(claim))) {
        throw new Error(`Unexpected claim outcome for ${record.handoffId}`);
      }
    }
  }
}

export function successfulRun(
  stateDir: string,
  identity: ToolObservation,
  prompt: string,
): boolean {
  const path = resolve(stateDir, "agents/main/agent/openclaw-agent.sqlite");
  if (!existsSync(path)) return false;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(`
      SELECT e.event_json FROM trajectory_runtime_events e
      JOIN session_windows w ON w.session_id = e.session_id
      WHERE w.session_key = ? AND e.session_id = ? AND e.run_id = ?
      ORDER BY e.created_at, e.seq
    `)
      .all(identity.sessionKey, identity.sessionId, identity.runId);
    let submitted = false;
    for (const row of rows) {
      if (typeof row.event_json !== "string") throw new Error("Invalid trajectory event JSON");
      const event = JSON.parse(row.event_json) as {
        type: string;
        data?: {
          prompt?: string;
          status?: string;
          stopReason?: string;
          aborted?: boolean;
          externalAbort?: boolean;
          timedOut?: boolean;
          idleTimedOut?: boolean;
          timedOutDuringCompaction?: boolean;
          timedOutDuringToolExecution?: boolean;
          timedOutByRunBudget?: boolean;
        };
      };
      if (event.type === "prompt.submitted" && event.data?.prompt?.includes(prompt))
        submitted = true;
      if (submitted && event.type === "session.ended") {
        if (
          event.data?.status !== "success" ||
          event.data.stopReason !== "stop" ||
          event.data.aborted === true ||
          event.data.externalAbort === true ||
          event.data.timedOut === true ||
          event.data.idleTimedOut === true ||
          event.data.timedOutDuringCompaction === true ||
          event.data.timedOutDuringToolExecution === true ||
          event.data.timedOutByRunBudget === true
        ) {
          throw new Error(`Run did not end successfully: ${identity.runId}`);
        }
        return true;
      }
    }
    return false;
  } finally {
    database.close();
  }
}

function toolIdentity(event: ToolObservation): string {
  return `${event.sessionKey}/${event.sessionId}/${event.runId}/${event.toolCallId}`;
}
