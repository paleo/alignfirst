import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function patchEnvFile(content: string, patches: Record<string, string>): string {
  const lines = content.trimEnd().split("\n");
  for (const [key, value] of Object.entries(patches)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx !== -1) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function extractHost(content: string, key: string, fallback = "localhost"): string {
  const re = new RegExp(`^${key}=(?:https?://)?([^:\\s]+)`, "m");
  const m = content.match(re);
  return m ? m[1] : fallback;
}

export interface CopyAndPatchCtx {
  currentWorktree: string;
  mainWorktree: string;
  log: (msg: string) => void;
}

export function copyAndPatchFile(
  ctx: CopyAndPatchCtx,
  relPath: string,
  patchFn: (content: string) => string,
  label: string,
  force: boolean,
  required = false,
): void {
  const targetPath = join(ctx.currentWorktree, relPath);
  const sourcePath = join(ctx.mainWorktree, relPath);
  const alreadyExists = existsSync(targetPath);

  if (alreadyExists && !force) {
    ctx.log(`Skipped ${label} (already exists; use --force to overwrite).`);
    return;
  }

  if (!existsSync(sourcePath)) {
    if (required) {
      console.error(`Error: ${relPath} not found in main worktree (required).`);
      process.exit(1);
    }
    ctx.log(`Warning: ${relPath} not found in main worktree, skipping.`);
    return;
  }

  const content = readFileSync(sourcePath, "utf-8");
  const patched = patchFn(content);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, patched);
  ctx.log(`${alreadyExists ? "Overwritten" : "Created"} ${label}.`);
}
