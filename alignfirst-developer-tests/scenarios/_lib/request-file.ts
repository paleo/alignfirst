import { access, readFile } from "node:fs/promises";

export async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return await readFile(path, "utf8");
    } catch {
      await delay(500);
    }
  }
  throw new Error(`file ${path} did not appear within ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
