// The only module that knows the two SQLite runtimes: `node:sqlite` under Node, `bun:sqlite` under
// Bun.
import type { DatabaseSync } from "node:sqlite";

// One import per process, so that concurrent opens share one warning filter.
let nodeSqlite: Promise<typeof DatabaseSync> | undefined;

export interface SqliteDatabase {
  exec(sql: string): void;
  // undefined when no row matches.
  get(sql: string, ...params: string[]): Record<string, unknown> | undefined;
  close(): void;
}

export function openSqlite(path: string): Promise<SqliteDatabase> {
  return process.versions.bun === undefined ? openNodeSqlite(path) : openBunSqlite(path);
}

async function openNodeSqlite(path: string): Promise<SqliteDatabase> {
  nodeSqlite ??= importNodeSqlite();
  const Database = await nodeSqlite;
  const database = new Database(path);
  return {
    exec: (sql) => database.exec(sql),
    get: (sql, ...params) => database.prepare(sql).get(...params),
    close: () => database.close(),
  };
}

// Node 22 warns that SQLite is experimental when the module loads. Every other warning still
// prints.
async function importNodeSqlite(): Promise<typeof DatabaseSync> {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteWarning(warning, rest[0])) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
  try {
    // A dynamic import: `node:sqlite` is absent under Bun, and its import emits the warning.
    return (await import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function isSqliteWarning(warning: string | Error, type: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return type === "ExperimentalWarning" && message.startsWith("SQLite");
}

async function openBunSqlite(path: string): Promise<SqliteDatabase> {
  // A dynamic import: `bun:sqlite` exists only under Bun.
  const { Database } = await import("bun:sqlite");
  const database = new Database(path);
  return {
    exec: (sql) => database.exec(sql),
    get: (sql, ...params) => database.prepare(sql).get(...params) ?? undefined,
    close: () => database.close(),
  };
}
