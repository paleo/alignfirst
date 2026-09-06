import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HandoffError } from "./errors.js";
import type { DeliveryReceipt, HandoffRecord } from "./types.js";

const DATABASE_DIRECTORY_MODE = 0o700;
const DATABASE_FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;
const STORE_CAPACITY = 10_000;

export interface HandoffStore {
  insertReceipt(receipt: DeliveryReceipt, now: number): void;
  findReceipt(identity: ReceiptIdentity, now: number): DeliveryReceipt | undefined;
  findHandoffByRoute(routeKey: string): HandoffRecord | undefined;
  insertHandoff(record: HandoffRecord): { inserted: boolean; record: HandoffRecord };
  claimHandoff(identity: ClaimIdentity, now: number): ClaimResult;
  updateEnqueued(routeKey: string, enqueuedAt: number): HandoffRecord | undefined;
  listPending(now: number, retryIntervalMs: number): HandoffRecord[];
  listHandoffs(): HandoffRecord[];
  retireClaimed(handoffId: string): boolean;
  close(): void;
}

export interface ReceiptIdentity {
  sourceSessionKey: string;
  sourceSessionId: string;
  threadId: string;
}

export interface ClaimIdentity {
  targetSessionKey: string;
  agentId: string;
  accountId?: string;
  handoffId?: string;
}

export interface ClaimResult {
  status: "claimed" | "alreadyClaimed" | "none";
  record?: HandoffRecord;
}

export function createHandoffStore(stateDir: string): HandoffStore {
  const database = openDatabase(resolveDatabasePath(stateDir));
  return createStoreOperations(database);
}

export function verifyPersistenceOpen(stateDir: string): string {
  const databasePath = resolveDatabasePath(stateDir);
  createHandoffStore(stateDir).close();
  return databasePath;
}

export function resolveDatabasePath(stateDir: string): string {
  return join(stateDir, "thread-handoff", "state.sqlite");
}

function openDatabase(databasePath: string): DatabaseSync {
  const directoryPath = dirname(databasePath);
  mkdirSync(directoryPath, { recursive: true, mode: DATABASE_DIRECTORY_MODE });
  chmodSync(directoryPath, DATABASE_DIRECTORY_MODE);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 2000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = FULL;");
    initializeSchema(database);
    chmodSync(databasePath, DATABASE_FILE_MODE);
    return database;
  } catch (error) {
    database?.close();
    throw persistentStateError(
      `Could not open the thread-handoff database: ${errorMessage(error)}`,
      error,
    );
  }
}

function initializeSchema(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version === SCHEMA_VERSION) return;
  if (row.user_version !== 0) {
    throw new Error(`Unsupported thread-handoff database schema ${row.user_version}.`);
  }
  inTransaction(database, () => {
    database.exec(`
      CREATE TABLE receipts (
        receipt_key TEXT PRIMARY KEY,
        source_session_key TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX receipts_lookup_idx
        ON receipts (source_session_key, source_session_id, thread_id, expires_at);
      CREATE INDEX receipts_expiry_idx ON receipts (expires_at);
      CREATE TABLE handoffs (
        route_key TEXT PRIMARY KEY,
        target_session_key TEXT NOT NULL UNIQUE,
        handoff_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed')),
        last_enqueued_at INTEGER,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX handoffs_pending_idx ON handoffs (state, last_enqueued_at);
      PRAGMA user_version = 1;
    `);
  });
}

function createStoreOperations(database: DatabaseSync): HandoffStore {
  return {
    insertReceipt: (receipt, now) => insertReceipt(database, receipt, now),
    findReceipt: (identity, now) => findReceipt(database, identity, now),
    findHandoffByRoute: (routeKey) => findHandoffByRoute(database, routeKey),
    insertHandoff: (record) => insertHandoff(database, record),
    claimHandoff: (identity, now) => claimHandoff(database, identity, now),
    updateEnqueued: (routeKey, enqueuedAt) => updateEnqueued(database, routeKey, enqueuedAt),
    listPending: (now, retryIntervalMs) => listPending(database, now, retryIntervalMs),
    listHandoffs: () => listHandoffs(database),
    retireClaimed: (handoffId) => retireClaimed(database, handoffId),
    close: () => database.close(),
  };
}

function insertReceipt(database: DatabaseSync, receipt: DeliveryReceipt, now: number): void {
  runStateOperation("store a delivery receipt", () =>
    inTransaction(database, () => {
      database.prepare("DELETE FROM receipts WHERE expires_at <= ?").run(now);
      const existing = database
        .prepare("SELECT receipt_key FROM receipts WHERE receipt_key = ?")
        .get(receipt.receiptKey);
      if (!existing) assertCapacity(database, "receipts");
      database
        .prepare(
          `INSERT INTO receipts (
             receipt_key, source_session_key, source_session_id, thread_id, expires_at, record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(receipt_key) DO UPDATE SET
             source_session_key = excluded.source_session_key,
             source_session_id = excluded.source_session_id,
             thread_id = excluded.thread_id,
             expires_at = excluded.expires_at,
             record_json = excluded.record_json`,
        )
        .run(
          receipt.receiptKey,
          receipt.sessionKey,
          receipt.sessionId,
          receipt.threadId,
          receipt.expiresAt,
          JSON.stringify(receipt),
        );
    }),
  );
}

function findReceipt(
  database: DatabaseSync,
  identity: ReceiptIdentity,
  now: number,
): DeliveryReceipt | undefined {
  return runStateOperation("read a delivery receipt", () => {
    database.prepare("DELETE FROM receipts WHERE expires_at <= ?").run(now);
    const row = database
      .prepare(
        `SELECT record_json FROM receipts
         WHERE source_session_key = ? AND source_session_id = ? AND thread_id = ?
           AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 1`,
      )
      .get(identity.sourceSessionKey, identity.sourceSessionId, identity.threadId, now) as JsonRow;
    return row ? parseReceipt(row.record_json) : undefined;
  });
}

function findHandoffByRoute(database: DatabaseSync, routeKey: string): HandoffRecord | undefined {
  return runStateOperation("read a handoff", () => {
    const row = database
      .prepare("SELECT record_json FROM handoffs WHERE route_key = ?")
      .get(routeKey) as JsonRow;
    return row ? parseHandoff(row.record_json) : undefined;
  });
}

function insertHandoff(
  database: DatabaseSync,
  record: HandoffRecord,
): { inserted: boolean; record: HandoffRecord } {
  return runStateOperation("store a handoff", () =>
    inTransaction(database, () => {
      const existing = readHandoffByRoute(database, record.routeKey);
      if (existing) return { inserted: false, record: existing };
      assertCapacity(database, "handoffs");
      database
        .prepare(
          `INSERT INTO handoffs (
             route_key, target_session_key, handoff_id, state, last_enqueued_at, record_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.routeKey,
          record.targetSessionKey,
          record.handoffId,
          record.state,
          record.lastEnqueuedAt ?? null,
          JSON.stringify(record),
        );
      return { inserted: true, record };
    }),
  );
}

function readHandoffByRoute(database: DatabaseSync, routeKey: string): HandoffRecord | undefined {
  const row = database
    .prepare("SELECT record_json FROM handoffs WHERE route_key = ?")
    .get(routeKey) as JsonRow;
  return row ? parseHandoff(row.record_json) : undefined;
}

function claimHandoff(database: DatabaseSync, identity: ClaimIdentity, now: number): ClaimResult {
  return runStateOperation("claim a handoff", () =>
    inTransaction(database, () => {
      const row = findClaimRow(database, identity);
      if (!row) return { status: "none" };
      const record = parseHandoff(row.record_json);
      assertClaimIdentity(record, identity);
      if (record.state === "claimed") return { status: "alreadyClaimed", record };
      const claimed: HandoffRecord = { ...record, state: "claimed", claimedAt: now };
      const result = database
        .prepare(
          `UPDATE handoffs SET state = 'claimed', record_json = ?
           WHERE route_key = ? AND state = 'pending'`,
        )
        .run(JSON.stringify(claimed), record.routeKey);
      if (result.changes === 1) return { status: "claimed", record: claimed };
      const current = readHandoffByRoute(database, record.routeKey);
      if (!current) return { status: "none" };
      return { status: "alreadyClaimed", record: current };
    }),
  );
}

function findClaimRow(database: DatabaseSync, identity: ClaimIdentity): JsonRow {
  if (identity.handoffId !== undefined) {
    return database
      .prepare("SELECT record_json FROM handoffs WHERE handoff_id = ?")
      .get(identity.handoffId) as JsonRow;
  }
  return database
    .prepare("SELECT record_json FROM handoffs WHERE target_session_key = ?")
    .get(identity.targetSessionKey) as JsonRow;
}

function assertClaimIdentity(record: HandoffRecord, identity: ClaimIdentity): void {
  if (
    record.targetSessionKey !== identity.targetSessionKey ||
    record.agentId !== identity.agentId ||
    record.accountId !== identity.accountId ||
    (identity.handoffId !== undefined && record.handoffId !== identity.handoffId)
  ) {
    throw new HandoffError("invalidTarget", "This session cannot claim the requested handoff.");
  }
}

function updateEnqueued(
  database: DatabaseSync,
  routeKey: string,
  enqueuedAt: number,
): HandoffRecord | undefined {
  return runStateOperation("record handoff enqueue time", () =>
    inTransaction(database, () => {
      const current = readHandoffByRoute(database, routeKey);
      if (current?.state !== "pending") return current;
      const updated: HandoffRecord = { ...current, lastEnqueuedAt: enqueuedAt };
      database
        .prepare(
          `UPDATE handoffs SET last_enqueued_at = ?, record_json = ?
           WHERE route_key = ? AND state = 'pending'`,
        )
        .run(enqueuedAt, JSON.stringify(updated), routeKey);
      return updated;
    }),
  );
}

function listPending(
  database: DatabaseSync,
  now: number,
  retryIntervalMs: number,
): HandoffRecord[] {
  return runStateOperation("list pending handoffs", () => {
    const rows = database
      .prepare(
        `SELECT record_json FROM handoffs
         WHERE state = 'pending' AND (last_enqueued_at IS NULL OR last_enqueued_at <= ?)
         ORDER BY COALESCE(last_enqueued_at, 0), rowid`,
      )
      .all(now - retryIntervalMs) as unknown as StoredJsonRow[];
    return rows.map((row) => parseHandoff(row.record_json));
  });
}

function listHandoffs(database: DatabaseSync): HandoffRecord[] {
  return runStateOperation("list handoffs", () => {
    const rows = database
      .prepare("SELECT record_json FROM handoffs ORDER BY rowid")
      .all() as unknown as StoredJsonRow[];
    return rows.map((row) => parseHandoff(row.record_json));
  });
}

function retireClaimed(database: DatabaseSync, handoffId: string): boolean {
  return runStateOperation("retire a handoff", () =>
    inTransaction(database, () => {
      const row = database
        .prepare("SELECT record_json FROM handoffs WHERE handoff_id = ?")
        .get(handoffId) as JsonRow;
      if (!row) return false;
      const record = parseHandoff(row.record_json);
      if (record.state !== "claimed") {
        throw new HandoffError("conflictingHandoff", "Pending handoffs cannot be retired.");
      }
      const result = database
        .prepare("DELETE FROM handoffs WHERE handoff_id = ? AND state = 'claimed'")
        .run(handoffId);
      return result.changes === 1;
    }),
  );
}

function assertCapacity(database: DatabaseSync, table: "receipts" | "handoffs"): void {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  if (row.count < STORE_CAPACITY) return;
  const error = new Error(`${table} capacity ${STORE_CAPACITY} reached.`);
  Object.assign(error, { code: "STORE_LIMIT_EXCEEDED" });
  throw error;
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the operation failure.
    }
    throw error;
  }
}

function runStateOperation<T>(description: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw persistentStateError(`Could not ${description}: ${errorMessage(error)}`, error);
  }
}

function persistentStateError(message: string, cause: unknown): HandoffError {
  return new HandoffError("unavailablePersistentState", message, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseReceipt(json: string): DeliveryReceipt {
  const value = parseRecord(json, "delivery receipt");
  if (
    value.schemaVersion !== 1 ||
    typeof value.receiptKey !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.starterText !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new Error("Invalid delivery receipt record.");
  }
  return value as unknown as DeliveryReceipt;
}

function parseHandoff(json: string): HandoffRecord {
  const value = parseRecord(json, "handoff");
  if (
    value.schemaVersion !== 1 ||
    typeof value.routeKey !== "string" ||
    typeof value.handoffId !== "string" ||
    typeof value.targetSessionKey !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.starterText !== "string" ||
    (value.state !== "pending" && value.state !== "claimed")
  ) {
    throw new Error("Invalid handoff record.");
  }
  return value as unknown as HandoffRecord;
}

function parseRecord(json: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Corrupt ${label} JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} record.`);
  }
  return value as Record<string, unknown>;
}

type StoredJsonRow = { record_json: string };
type JsonRow = StoredJsonRow | undefined;
