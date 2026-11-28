import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "../errors.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

// The realm of a row that belongs to the OS account.
export const GLOBAL_REALM = "global";

// Step `n` brings `user_version` from `n` to `n + 1`. No table or column name is a keyword, reserved
// or not, in SQLite or in the SQL standard. `STRICT` would reject the type name `TIMESTAMP`.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE store (
    realm      TEXT NOT NULL,
    entry      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (realm, entry)
  )`,
];
const BUSY_TIMEOUT_MS = 5000;
// The UTC text of SQLite's `CURRENT_TIMESTAMP`.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// The AlignDev memory, shared by the AlignDev instances of the OS account. When it cannot be used,
// it stays unavailable for the invocation: reads find nothing, writes do nothing, and the file
// stays untouched.
export interface Memory {
  // Why the memory is unavailable for this invocation, when it is.
  unavailability(): Promise<string | undefined>;
  read(realm: string, entry: string): Promise<MemoryRow | undefined>;
  // The row as written; undefined when the memory is unavailable.
  write(realm: string, entry: string, payload: unknown): Promise<MemoryRow | undefined>;
  close(): void;
}

export interface MemoryRow {
  payload: unknown;
  // The last write, parsed from the UTC text of SQLite.
  updatedAt: Date;
}

// The connection opens at the first call.
export function createMemory(home: string): Memory {
  let opening: Promise<void> | undefined;
  let database: SqliteDatabase | undefined;
  let reason: string | undefined;

  async function connect(): Promise<SqliteDatabase | undefined> {
    opening ??= openDatabase(memoryPath(home)).then(
      (opened) => {
        database = opened;
      },
      (error: unknown) => {
        reason = errorMessage(error);
      },
    );
    await opening;
    return database;
  }

  async function use<T>(action: (opened: SqliteDatabase) => T): Promise<T | undefined> {
    const opened = await connect();
    if (opened === undefined) return;
    try {
      return action(opened);
    } catch (error) {
      reason = errorMessage(error);
      close();
      return;
    }
  }

  function close(): void {
    const opened = database;
    database = undefined;
    try {
      opened?.close();
    } catch {
      // The connection is gone either way.
    }
  }

  return {
    async unavailability() {
      await connect();
      return reason;
    },
    async read(realm, entry) {
      return use((opened) => readRow(opened, realm, entry));
    },
    async write(realm, entry, payload) {
      return use((opened) => writeRow(opened, realm, entry, JSON.stringify(payload)));
    },
    close,
  };
}

// <home>/.alignfirst/aligndev.store.sqlite
export function memoryPath(home: string): string {
  return join(home, ".alignfirst", "aligndev.store.sqlite");
}

// Parts joined with `:`, the object first as `type:id` pairs, the attribute last. In an id, `%` is
// written `%25` and `:` is written `%3A`.
export function entryName(
  object: readonly (readonly [type: string, id: string])[],
  attribute: string,
): string {
  const pairs = object.map(([type, id]) => `${type}:${escapeId(id)}`);
  return [...pairs, attribute].join(":");
}

function escapeId(id: string): string {
  return id.replaceAll("%", "%25").replaceAll(":", "%3A");
}

async function openDatabase(path: string): Promise<SqliteDatabase> {
  mkdirSync(dirname(path), { recursive: true });
  const database = await openSqlite(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

// Each step reads the version again in its transaction, so two instances cannot apply it twice.
function migrate(database: SqliteDatabase): void {
  for (;;) {
    const version = readVersion(database);
    if (version > MIGRATIONS.length) {
      throw new Error(
        `the file has schema version ${version}; this AlignDev knows up to ${MIGRATIONS.length}`,
      );
    }
    if (version === MIGRATIONS.length) return;
    inTransaction(database, () => {
      if (readVersion(database) !== version) return;
      database.exec(MIGRATIONS[version]);
      database.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

function readVersion(database: SqliteDatabase): number {
  const version = database.get("PRAGMA user_version")?.user_version;
  if (typeof version !== "number") throw new Error("the file has no readable schema version");
  return version;
}

function inTransaction<T>(database: SqliteDatabase, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite may have rolled back already.
    }
    throw error;
  }
}

function readRow(database: SqliteDatabase, realm: string, entry: string): MemoryRow | undefined {
  return toMemoryRow(
    database.get(
      "SELECT payload, updated_at FROM store WHERE realm = ? AND entry = ?",
      realm,
      entry,
    ),
  );
}

// The row comes back from the upsert, so a concurrent writer cannot replace it before it is read.
function writeRow(
  database: SqliteDatabase,
  realm: string,
  entry: string,
  payload: string,
): MemoryRow | undefined {
  return inTransaction(database, () =>
    toMemoryRow(
      database.get(
        "INSERT INTO store (realm, entry, payload) VALUES (?, ?, ?) " +
          "ON CONFLICT (realm, entry) DO UPDATE SET " +
          "payload = excluded.payload, updated_at = CURRENT_TIMESTAMP " +
          "RETURNING payload, updated_at",
        realm,
        entry,
        payload,
      ),
    ),
  );
}

// A row whose payload or time cannot be read is absent.
function toMemoryRow(row: Record<string, unknown> | undefined): MemoryRow | undefined {
  if (row === undefined) return;
  const { payload, updated_at: updatedAt } = row;
  if (typeof payload !== "string" || typeof updatedAt !== "string") return;
  if (!TIMESTAMP_PATTERN.test(updatedAt)) return;
  const time = new Date(`${updatedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(time.getTime())) return;
  try {
    return { payload: JSON.parse(payload), updatedAt: time };
  } catch {
    return;
  }
}
