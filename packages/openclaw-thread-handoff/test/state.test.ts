import { chmodSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createHandoffStore, resolveDatabasePath } from "../src/state.js";
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

  it("claims atomically across independent connections", async () => {
    const stateDir = temporaryStateDir();
    const first = createHandoffStore(stateDir);
    const second = createHandoffStore(stateDir);
    first.insertHandoff(handoff());
    const identity = {
      targetSessionKey: handoff().targetSessionKey,
      agentId: "main",
      accountId: "workspace-1",
      handoffId: "handoff-1",
    };
    const results = await Promise.all([
      Promise.resolve().then(() => first.claimHandoff(identity, 2_000).status),
      Promise.resolve().then(() => second.claimHandoff(identity, 2_001).status),
    ]);
    expect(results.sort()).toEqual(["alreadyClaimed", "claimed"]);
    first.close();
    second.close();
  });

  it("rejects mismatched claim identities and pending retirement", () => {
    const store = createHandoffStore(temporaryStateDir());
    store.insertHandoff(handoff());
    expect(() =>
      store.claimHandoff(
        { targetSessionKey: handoff().targetSessionKey, agentId: "other", handoffId: "handoff-1" },
        2_000,
      ),
    ).toThrow(/invalidTarget|cannot claim/);
    expect(() => store.retireClaimed("handoff-1")).toThrow(/Pending handoffs/);
    store.close();
  });

  it("rejects unknown schemas and unavailable files", () => {
    const stateDir = temporaryStateDir();
    const path = resolveDatabasePath(stateDir);
    const initialized = createHandoffStore(stateDir);
    initialized.close();
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 2;");
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
             (route_key, target_session_key, handoff_id, state, last_enqueued_at, record_json)
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
