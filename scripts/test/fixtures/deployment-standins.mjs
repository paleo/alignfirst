import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Every stand-in appends tab-separated records to one journal; fixtures replay it:
//   call <name> <args...>          one per invocation
//   create <role> <mode> <path>    a path created or copied by <role> (root, service, operator)
//   chown <user:group> <path>      chattr <+i|-i> <path>      chmod <octal> <path>
// Harness-specific stand-ins add their own kinds (native, snapshot); replay ignores them.
const standInDirectory = fileURLToPath(new URL("./deployment-bin/", import.meta.url));

const defaultEntry = { owner: "service", mode: 0o700, immutable: false };

/**
 * Copies stand-ins into a fixture's bin directory. An entry is a name or [installed name, source];
 * a Node source (.mjs) gets a launcher bound to this Node executable.
 */
export function installStandIns(bin, entries) {
  for (const entry of entries) {
    const [name, source] = typeof entry === "string" ? [entry, entry] : entry;
    const target = join(bin, name);
    if (source.endsWith(".mjs"))
      writeFileSync(
        target,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(standInDirectory, source))} "$@"\n`,
      );
    else copyFileSync(join(standInDirectory, source), target);
    chmodSync(target, 0o755);
  }
}

export function standInEnv({ root, home, bin, journal }) {
  return {
    STANDIN_ROOT: root,
    STANDIN_HOME: home,
    STANDIN_PATH: bin,
    STANDIN_JOURNAL: journal,
    STANDIN_SOURCE: standInDirectory,
    STANDIN_NODE: process.execPath,
  };
}

export function readJournal(path) {
  return existsSync(path) ? parseJournal(readFileSync(path, "utf8")) : [];
}

export function parseJournal(text) {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

export function journalCalls(records) {
  return records.filter(([kind]) => kind === "call").map((record) => record.slice(1));
}

/** Replays ownership, modes and immutable flags: path -> { owner, mode, immutable }. */
export function replayState(records) {
  const state = {};
  const entry = (path) => {
    state[path] ??= { ...defaultEntry };
    return state[path];
  };
  for (const [kind, ...fields] of records) {
    if (kind === "create") {
      const [owner, mode, path] = fields;
      state[path] = { owner, mode: Number.parseInt(mode, 8), immutable: false };
    } else if (kind === "chown") entry(fields[1]).owner = ownerRole(fields[0]);
    else if (kind === "chmod") entry(fields[1]).mode = Number.parseInt(fields[0], 8);
    else if (kind === "chattr") entry(fields[1]).immutable = fields[0] === "+i";
  }
  return state;
}

export function stateEntry(state, path) {
  return state[path] ?? defaultEntry;
}

export function ownerRole(spec) {
  const user = spec.split(":")[0];
  return user === "fixture" ? "service" : user;
}

export function callRecord(name, args) {
  return `${["call", name, ...args.map((arg) => (arg.includes("\n") ? "<multiline>" : arg))].join("\t")}\n`;
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
