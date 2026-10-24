import { appendFileSync, readFileSync, realpathSync } from "node:fs";
if (process.env.CLI_RUNTIME_AUDIT !== undefined) {
  appendFileSync(
    process.env.CLI_RUNTIME_AUDIT,
    `${JSON.stringify({
      pid: process.pid,
      parent: process.ppid,
      runtime: process.versions.bun === undefined ? "node" : "bun",
      version: process.versions.bun ?? process.version,
      executable: process.execPath,
      argv: process.argv.slice(1),
      entry: process.argv[1] === undefined ? undefined : canonicalEntry(process.argv[1]),
      parentArgv: parentArguments(),
      pathHead: process.env.PATH?.split(":").slice(0, 3),
      cwd: process.cwd(),
      managerCommand: process.env.npm_command,
      lifecycle: process.env.npm_lifecycle_event,
    })}\n`,
  );
}

function canonicalEntry(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function parentArguments() {
  try {
    return readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}
