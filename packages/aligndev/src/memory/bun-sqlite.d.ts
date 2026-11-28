// The part of Bun's built-in SQLite module that the adapter uses. Bun provides the module at
// runtime; no package declares it.
declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }

  export interface Statement {
    // null when no row matches.
    get(...params: string[]): Record<string, unknown> | null;
  }
}
