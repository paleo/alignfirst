import type * as FileSystem from "node:fs";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readMachineId } from "../../src/code/machine-id.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, linkSync: vi.fn(fs.linkSync), writeFileSync: vi.fn(fs.writeFileSync) };
});

describe("readMachineId", () => {
  let home: string;
  let path: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aligndev-machine-"));
    path = join(home, ".alignfirst", "machine-id");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a UUID once and returns the same identity on later reads", () => {
    const id = readMachineId(home);
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(readFileSync(path, "utf8")).toBe(id);
    expect(readMachineId(home)).toBe(id);
  });

  it("keeps an existing identity and trims surrounding whitespace", () => {
    mkdirSync(join(home, ".alignfirst"));
    writeFileSync(path, "  existing-installation\n");
    expect(readMachineId(home)).toBe("existing-installation");
    expect(readFileSync(path, "utf8")).toBe("  existing-installation\n");
  });

  it("reads the winning identity when another creator links first", () => {
    const original = vi.mocked(writeFileSync).getMockImplementation();
    if (!original) throw new Error("Missing filesystem implementation.");
    vi.mocked(writeFileSync).mockImplementationOnce((file, ...args) => {
      original(path, "winner");
      return original(file, ...args);
    });
    expect(readMachineId(home)).toBe("winner");
    expect(readFileSync(path, "utf8")).toBe("winner");
    expect(tempFiles()).toEqual([]);
  });

  it("reports an empty identity without replacing it", () => {
    mkdirSync(join(home, ".alignfirst"));
    writeFileSync(path, " \n");
    expect(() => readMachineId(home)).toThrow(path);
    expect(() => readMachineId(home)).toThrow("empty");
    expect(readFileSync(path, "utf8")).toBe(" \n");
  });

  it("names an unreadable identity path", () => {
    mkdirSync(path, { recursive: true });
    expect(() => readMachineId(home)).toThrow(path);
  });

  it("names the identity path and removes the temporary file when publishing fails", () => {
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("link failed"), { code: "EIO" });
    });
    expect(() => readMachineId(home)).toThrow(path);
    expect(tempFiles()).toEqual([]);
  });

  function tempFiles(): string[] {
    return readdirSync(join(home, ".alignfirst")).filter((name) => name.endsWith(".tmp"));
  }
});
