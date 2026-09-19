import { access, readFile } from "node:fs/promises";

/**
 * Wait for the request file, then check it carries the whole recorded request. The playbook
 * lets the bot fix typos, so quote marks and whitespace are compared in their normalized form.
 */
export async function waitForCapturedRequest(
  path: string,
  request: string,
  timeoutMs: number,
): Promise<string> {
  const file = await waitForFile(path, timeoutMs);
  if (!normalizeProse(file).includes(normalizeProse(request))) {
    throw new Error(`captured request omitted details: ${JSON.stringify(file)}`);
  }
  return file;
}

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

function normalizeProse(text: string): string {
  return text.replaceAll(/[‘’]/gu, "'").replaceAll(/[“”]/gu, '"').replaceAll(/\s+/gu, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
