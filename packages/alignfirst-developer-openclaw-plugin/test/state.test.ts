import { chmodSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createHandoffStore, resolveDatabasePath } from "../src/thread-handoff/state.js";
import { handoff, receipt, temporaryStateDir } from "./helpers.js";

describe("handoff SQLite state", () => {
  it("persists records across opens with protected filesystem modes", () => {
    const stateDir = temporaryStateDir();
    const first = createHandoffStore(stateDir);
    first.insertReceipt(receipt(), 1_000);
    first.insertHandoff(handoff());
    first.close();

    const second = createHandoffStore(stateDir);
    expect(
      second.findReceipt(
        {
          sourceSessionKey: receipt().sessionKey,
          sourceSessionId: "source-uuid",
          threadId: "100.200",
        },
        1_001,
      ),
    ).toMatchObject({ starterText: "Please do the work." });
    expect(second.findHandoffByRoute("route-1")).toMatchObject({ handoffId: "handoff-1" });
    expect(statSync(resolveDatabasePath(stateDir)).mode & 0o777).toBe(0o600);
    expect(statSync(`${stateDir}/thread-handoff`).mode & 0o777).toBe(0o700);
    second.close();
  });

  it("prunes expired receipts without removing handoffs", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertReceipt(receipt({ expiresAt: 2_000 }), 1_000);
    store.insertHandoff(handoff());
    expect(
      store.findReceipt(
        {
          sourceSessionKey: receipt().sessionKey,
          sourceSessionId: "source-uuid",
          threadId: "100.200",
        },
        2_000,
      ),
    ).toBeUndefined();
    expect(store.findHandoffByRoute("route-1")).toBeDefined();
    store.close();
  });

  it("lists active receipts in insertion order and prunes expired rows", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertReceipt(receipt({ receiptKey: "first", expiresAt: 3_000 }), 1_000);
    store.insertReceipt(
      receipt({ receiptKey: "expired", threadId: "expired", expiresAt: 2_000 }),
      1_000,
    );
    store.insertReceipt(
      receipt({ receiptKey: "second", threadId: "second", expiresAt: 4_000 }),
      1_000,
    );

    expect(store.listReceipts(2_000).map((record) => record.receiptKey)).toEqual([
      "first",
      "second",
    ]);
    store.close();
  });

  it("claims atomically across independent connections", async () => {
    const stateDir = temporaryStateDir();
    const first = createHandoffStore(stateDir);
    const second = createHandoffStore(stateDir);
    first.insertHandoff(handoff());
    const identity = {
      targetSessionKey: handoff().targetSessionKey,
      agentId: "main",
      sessionId: "target-uuid",
      runId: "run-1",
      accountId: "workspace-1",
      handoffId: "handoff-1",
    };
    const results = await Promise.all([
      Promise.resolve().then(() => first.claimHandoff(identity, 2_000).status),
      Promise.resolve().then(() => second.claimHandoff(identity, 2_001).status),
    ]);
    expect(results).toEqual(["claimed", "claimed"]);
    first.close();
    second.close();
  });

  it("makes a claim idempotent for its run and rejects another run", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff());
    const first = store.claimHandoff(claimIdentity({ runId: "run-1" }), 2_000);
    const repeated = store.claimHandoff(claimIdentity({ runId: "run-1" }), 3_000);
    const other = store.claimHandoff(claimIdentity({ runId: "run-2" }), 4_000);

    expect(first).toMatchObject({ status: "claimed", record: { claimedAt: 2_000 } });
    expect(repeated).toMatchObject({ status: "claimed", record: { claimedAt: 2_000 } });
    expect(other).toMatchObject({ status: "alreadyClaimed", record: { claimedAt: 2_000 } });
    store.close();
  });

  it("falls back to session identity only when both claims omit a run id", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff());

    expect(store.claimHandoff(claimIdentity(), 2_000).status).toBe("claimed");
    expect(store.claimHandoff(claimIdentity(), 3_000).status).toBe("claimed");
    expect(store.claimHandoff(claimIdentity({ sessionId: "another-session" }), 4_000).status).toBe(
      "alreadyClaimed",
    );
    store.close();
  });

  it("treats a claimed record without claimer identity as owned by another run", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff({ state: "claimed", claimedAt: 1_500 }));
    expect(store.claimHandoff(claimIdentity({ runId: "run-1" }), 2_000)).toMatchObject({
      status: "alreadyClaimed",
      record: { claimedAt: 1_500 },
    });
    store.close();
  });

  it("migrates schema 1 handoffs and keeps attempts writable", () => {
    const stateDir = temporaryStateDir();
    const store = createHandoffStore(stateDir);
    store.insertHandoff(handoff());
    store.recordAttempt("route-1", 1_000);
    store.recordAttempt("route-1", 2_000);
    store.recordAttempt("route-1", 3_000);
    store.insertHandoff(
      handoff({ routeKey: "route-2", handoffId: "handoff-2", targetSessionKey: "target-2" }),
    );
    store.claimHandoff(
      claimIdentity({ targetSessionKey: "target-2", handoffId: "handoff-2", runId: "run-2" }),
      4_000,
    );
    store.close();
    downgradeToSchema1(resolveDatabasePath(stateDir));

    const migrated = createHandoffStore(stateDir);
    expect(migrated.findHandoffByRoute("route-1")).toMatchObject({
      schemaVersion: 2,
      attemptCount: 3,
      lastAttemptedAt: 3_000,
    });
    expect(migrated.findHandoffByRoute("route-2")).toMatchObject({
      schemaVersion: 2,
      state: "claimed",
    });
    expect(readSchemaVersion(resolveDatabasePath(stateDir))).toBe(2);
    expect(migrated.recordAttempt("route-1", 5_000)).toMatchObject({
      attemptCount: 4,
      lastAttemptedAt: 5_000,
    });
    migrated.close();
  });

  it("rejects mismatched claim identities and unforced pending retirement", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff());
    expect(() =>
      store.claimHandoff(
        {
          targetSessionKey: handoff().targetSessionKey,
          agentId: "other",
          sessionId: "target-uuid",
          handoffId: "handoff-1",
        },
        2_000,
      ),
    ).toThrow(/invalidTarget|cannot claim/);
    expect(() => store.retireHandoff("handoff-1", { force: false })).toThrow(/--force/);
    expect(store.retireHandoff("handoff-1", { force: true })).toBe(true);
    expect(store.findHandoffByRoute("route-1")).toBeUndefined();
    store.close();
  });

  it("lists pending handoffs due for an attempt and below the attempt cap", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff());
    store.insertHandoff(
      handoff({ routeKey: "route-2", handoffId: "handoff-2", targetSessionKey: "t2" }),
    );
    store.recordAttempt("route-2", 5_000);
    const query = { now: 10_000, spacingMs: 30_000, maxAttempts: 2 };
    expect(store.listPending(query).map((record) => record.handoffId)).toEqual(["handoff-1"]);
    expect(store.listPending({ ...query, now: 40_000 }).map((r) => r.handoffId)).toEqual([
      "handoff-1",
      "handoff-2",
    ]);
    store.recordAttempt("route-2", 40_000);
    expect(store.listPending({ ...query, now: 80_000 }).map((r) => r.handoffId)).toEqual([
      "handoff-1",
    ]);
    store.close();
  });

  it("rejects unknown schemas and unavailable files", () => {
    const stateDir = temporaryStateDir();
    const path = resolveDatabasePath(stateDir);
    const initialized = createHandoffStore(stateDir);
    initialized.close();
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 3;");
    database.close();
    expect(() => createHandoffStore(stateDir)).toThrow(/Unsupported/);

    const denied = temporaryStateDir();
    chmodSync(denied, 0o500);
    if (process.getuid?.() !== 0) expect(() => createHandoffStore(denied)).toThrow();
  });

  it.each(["receipts", "handoffs"] as const)("rejects %s overflow without eviction", (table) => {
    const stateDir = temporaryStateDir();
    createHandoffStore(stateDir).close();
    fillToCapacity(resolveDatabasePath(stateDir), table);
    const store = createHandoffStore(stateDir);
    const operation =
      table === "receipts"
        ? () => store.insertReceipt(receipt({ receiptKey: "overflow" }), 0)
        : () => store.insertHandoff(handoff({ routeKey: "overflow", handoffId: "overflow" }));
    expect(operation).toThrow(/capacity 10000/);
    expect(countRows(resolveDatabasePath(stateDir), table)).toBe(10_000);
    store.close();
  });

  it("surfaces corrupt stored JSON without resetting the database", () => {
    const stateDir = temporaryStateDir();
    const store = createHandoffStore(stateDir);
    store.insertHandoff(handoff());
    store.close();
    const database = new DatabaseSync(resolveDatabasePath(stateDir));
    database.prepare("UPDATE handoffs SET record_json = ? WHERE route_key = ?").run("{", "route-1");
    database.close();
    const reopened = createHandoffStore(stateDir);
    expect(() => reopened.findHandoffByRoute("route-1")).toThrow(/Corrupt handoff JSON/);
    reopened.close();
  });
});

function fillToCapacity(path: string, table: "receipts" | "handoffs"): void {
  const database = new DatabaseSync(path);
  database.exec("BEGIN IMMEDIATE;");
  const statement =
    table === "receipts"
      ? database.prepare(
          `INSERT INTO receipts
             (receipt_key, source_session_key, source_session_id, thread_id, expires_at, record_json)
           VALUES (?, 'source', 'uuid', 'thread', 9999999999999, '{}')`,
        )
      : database.prepare(
          `INSERT INTO handoffs
             (route_key, target_session_key, handoff_id, state, last_attempted_at, record_json)
           VALUES (?, ?, ?, 'claimed', NULL, '{}')`,
        );
  for (let index = 0; index < 10_000; index += 1) {
    const id = String(index);
    if (table === "receipts") statement.run(id);
    else statement.run(id, `target-${id}`, `handoff-${id}`);
  }
  database.exec("COMMIT;");
  database.close();
}

function claimIdentity(
  overrides: Partial<{
    targetSessionKey: string;
    agentId: string;
    sessionId: string;
    runId: string;
    accountId: string;
    handoffId: string;
  }> = {},
) {
  return {
    targetSessionKey: handoff().targetSessionKey,
    agentId: "main",
    sessionId: "target-uuid",
    accountId: "workspace-1",
    handoffId: "handoff-1",
    ...overrides,
  };
}

function downgradeToSchema1(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("ALTER TABLE handoffs RENAME COLUMN attempt_count TO enqueue_count;");
  database.exec("ALTER TABLE handoffs RENAME COLUMN last_attempted_at TO last_enqueued_at;");
  const rows = database
    .prepare("SELECT route_key, record_json FROM handoffs")
    .all() as unknown as Array<{ route_key: string; record_json: string }>;
  const update = database.prepare("UPDATE handoffs SET record_json = ? WHERE route_key = ?");
  for (const row of rows) {
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const { attemptCount, lastAttemptedAt, claimedBy: _claimedBy, ...rest } = record;
    update.run(
      JSON.stringify({
        ...rest,
        schemaVersion: 1,
        enqueueCount: attemptCount,
        ...(lastAttemptedAt !== undefined ? { lastEnqueuedAt: lastAttemptedAt } : {}),
      }),
      row.route_key,
    );
  }
  database.exec("PRAGMA user_version = 1;");
  database.close();
}

function readSchemaVersion(path: string): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  } finally {
    database.close();
  }
}

function countRows(path: string, table: "receipts" | "handoffs"): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}
