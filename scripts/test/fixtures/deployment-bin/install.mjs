import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  callRecord,
  ownerRole,
  parseJournal,
  replayState,
  stateEntry,
} from "../deployment-standins.mjs";

// Node, unlike the shell stand-ins: in the runbooks fixture, its copies go through the preloaded
// permission guard. As the service account it also enforces the reseed permission model: no
// root-owned or immutable target, and a writable parent for a new one.
const root = process.env.STANDIN_ROOT;
const journal = process.env.STANDIN_JOURNAL;
const role = process.env.STANDIN_ROLE ?? "root";

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function main(args) {
  appendFileSync(journal, callRecord("install", args));
  const options = parseOptions(args);
  const owner = options.owner === undefined ? role : ownerRole(options.owner);
  const targets = options.directory
    ? options.paths.map((path) => ({ path: inside(path) }))
    : copyTargets(options.paths.map(inside), options.parents);
  for (const { source, path } of targets) {
    if (role === "service") refuseProtectedTarget(path);
    if (source === undefined) mkdirSync(path, { recursive: true });
    else {
      if (options.parents) mkdirSync(dirname(path), { recursive: true });
      cpSync(source, path);
    }
    chmodSync(path, options.mode);
    appendFileSync(journal, `create\t${owner}\t${options.mode.toString(8)}\t${path}\n`);
  }
}

function parseOptions(args) {
  const options = { mode: 0o755, directory: false, parents: false, paths: [] };
  for (let index = 0; index < args.length; ++index) {
    const arg = args[index];
    if (arg === "-d") options.directory = true;
    else if (arg === "-D") options.parents = true;
    else if (arg === "-m") options.mode = Number.parseInt(args[++index], 8);
    else if (arg === "-o") options.owner = args[++index];
    else if (arg === "-g") ++index;
    else if (arg.startsWith("-")) throw new Error(`install: unsupported option ${arg}`);
    else options.paths.push(arg);
  }
  if (options.paths.length === 0 || Number.isNaN(options.mode))
    throw new Error("install: unsupported arguments");
  return options;
}

function copyTargets(paths, parents) {
  if (paths.length < 2) throw new Error("install: missing destination");
  const destination = paths.at(-1);
  const sources = paths.slice(0, -1);
  const intoDirectory =
    sources.length > 1 ||
    (!parents && existsSync(destination) && statSync(destination).isDirectory());
  return sources.map((source) => ({
    source,
    path: intoDirectory ? join(destination, basename(source)) : destination,
  }));
}

function inside(value) {
  const path = resolve(value);
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`OUTSIDE FIXTURE: ${path}`);
  return path;
}

function refuseProtectedTarget(path) {
  const state = replayState(parseJournal(readFileSync(journal, "utf8")));
  const target = stateEntry(state, path);
  if (existsSync(path)) {
    if (target.owner === "root" || target.immutable)
      throw new Error(`PERMISSION MODEL: install denied ${path}`);
    return;
  }
  const parent = stateEntry(state, dirname(path));
  if (parent.immutable || !(parent.mode & (parent.owner === "root" ? 0o020 : 0o200)))
    throw new Error(`PERMISSION MODEL: install denied ${path}`);
}
