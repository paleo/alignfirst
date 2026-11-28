import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createMemory, entryName, type Memory, memoryPath } from "../../src/memory/memory.js";

const ENTRY = "harness:codex:models";

const homes: string[] = [];
const memories: Memory[] = [];

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-memory-"));
  homes.push(home);
  return home;
}

function open(home: string): Memory {
  const memory = createMemory(home);
  memories.push(memory);
  return memory;
}

async function setUpdatedAt(home: string, entry: string, updatedAt: string): Promise<void> {
  const database = new DatabaseSync(memoryPath(home));
  try {
    database.prepare("UPDATE store SET updated_at = ? WHERE entry = ?").run(updatedAt, entry);
  } finally {
    database.close();
  }
}

// Writes a file at the memory's path before any AlignDev instance opens it.
function seedFile(home: string, content: Buffer): void {
  mkdirSync(dirname(memoryPath(home)), { recursive: true });
  writeFileSync(memoryPath(home), content);
}

describe("memory", () => {
  it("shares rows between instances, and a write replaces the payload and its time", async () => {
    const home = makeHome();
    await open(home).write("global", ENTRY, { models: ["a"] });
    await setUpdatedAt(home, ENTRY, "2026-11-27 08:00:00");
    expect(await open(home).read("global", ENTRY)).toEqual({
      payload: { models: ["a"] },
      updatedAt: new Date("2026-11-27T08:00:00Z"),
    });

    await open(home).write("global", ENTRY, { models: ["b"] });
    const replaced = await open(home).read("global", ENTRY);
    expect(replaced?.payload).toEqual({ models: ["b"] });
    expect(replaced?.updatedAt.getTime()).toBeGreaterThan(Date.parse("2026-11-27T08:00:00Z"));
    expect(await open(home).read("project:/x", ENTRY)).toBeUndefined();
  });

  it("reads a row whose time is not SQLite's UTC text as absent", async () => {
    const home = makeHome();
    await open(home).write("global", ENTRY, { models: ["a"] });
    await setUpdatedAt(home, ENTRY, "2026-11-27T08:00:00Z");
    expect(await open(home).read("global", ENTRY)).toBeUndefined();
  });

  it("names entries as the object pairs then the attribute, with escaped ids", () => {
    expect(
      entryName(
        [
          ["harness", "codex"],
          ["profile", "codex-personal"],
        ],
        "models",
      ),
    ).toBe("harness:codex:profile:codex-personal:models");
    expect(entryName([["harness", "agy"]], "models")).toBe("harness:agy:models");
    expect(
      entryName(
        [
          ["harness", "codex"],
          ["profile", "team:eu"],
        ],
        "models",
      ),
    ).toBe("harness:codex:profile:team%3Aeu:models");
    expect(entryName([["profile", "100%:a"]], "models")).toBe("profile:100%25%3Aa:models");
  });

  it("leaves a file of a newer schema untouched and unavailable", async () => {
    const home = makeHome();
    mkdirSync(dirname(memoryPath(home)));
    const database = new DatabaseSync(memoryPath(home));
    database.exec("PRAGMA user_version = 99");
    database.close();
    const bytes = readFileSync(memoryPath(home));

    const memory = open(home);
    expect(await memory.unavailability()).toBeDefined();
    await memory.write("global", ENTRY, { models: ["a"] });
    expect(await memory.read("global", ENTRY)).toBeUndefined();
    expect(readFileSync(memoryPath(home))).toEqual(bytes);
  });

  it("leaves a file that is not a database untouched and unavailable", async () => {
    const home = makeHome();
    const bytes = Buffer.from("not a database, but a file of the user\n".repeat(200));
    seedFile(home, bytes);

    const memory = open(home);
    expect(await memory.unavailability()).toMatch(/\S/);
    await memory.write("global", ENTRY, { models: ["a"] });
    expect(readFileSync(memoryPath(home))).toEqual(bytes);
  });

  it("is unavailable without throwing when its directory cannot be created", async () => {
    const home = join(makeHome(), "file");
    writeFileSync(home, "");
    const memory = open(home);
    await expect(memory.write("global", ENTRY, {})).resolves.toBeUndefined();
    await expect(memory.read("global", ENTRY)).resolves.toBeUndefined();
    expect(await memory.unavailability()).toBeDefined();
  });
});
