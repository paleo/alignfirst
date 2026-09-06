import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findExecutable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = env.PATH;
  if (path === undefined || path === "") return;
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
