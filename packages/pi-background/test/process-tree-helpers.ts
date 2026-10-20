import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FixturePid {
  pid: number;
  identity: string;
  role: string;
}

export function records(dir: string): FixturePid[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("pid" in value) ||
        !("identity" in value) ||
        !("role" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 1 ||
        typeof value.identity !== "string" ||
        typeof value.role !== "string"
      )
        throw new Error("Invalid fixture PID record.");
      return { pid: value.pid, identity: value.identity, role: value.role };
    });
}

export function isLive(record: FixturePid): boolean {
  try {
    const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === record.identity && fields[0] !== "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture synchronization timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
