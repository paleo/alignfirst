// The only module that knows the two SQLite runtimes: `node:sqlite` under Node, `bun:sqlite` under
// Bun.
export interface SqliteDatabase {
  exec(sql: string): void;
  // undefined when no row matches.
  get(sql: string, ...params: string[]): Record<string, unknown> | undefined;
  run(sql: string, ...params: string[]): void;
  close(): void;
}

export function openSqlite(path: string): Promise<SqliteDatabase> {
  return process.versions.bun === undefined ? openNodeSqlite(path) : openBunSqlite(path);
}

// Node 22 warns that SQLite is experimental at the first use. Every other warning still prints.
async function openNodeSqlite(path: string): Promise<SqliteDatabase> {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteWarning(warning, rest[0])) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
  try {
    // A dynamic import: `node:sqlite` is absent under Bun, and its import emits the warning.
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path);
    return {
      exec: (sql) => database.exec(sql),
      get: (sql, ...params) => database.prepare(sql).get(...params),
      run: (sql, ...params) => {
        database.prepare(sql).run(...params);
      },
      close: () => database.close(),
    };
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
    run: (sql, ...params) => {
      database.prepare(sql).run(...params);
    },
    close: () => database.close(),
  };
}
