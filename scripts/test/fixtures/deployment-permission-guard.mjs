import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJournal, replayState, stateEntry } from "./deployment-standins.mjs";

// Preloaded into every Node process of the runbooks fixture. It models ownership, immutable
// children and sticky-parent deletion for the service account from the stand-in journal, records
// the creator's role for new paths and fakes process.getuid(). Real OS enforcement remains host
// acceptance.
const root = process.env.STANDIN_ROOT;
const journal = process.env.STANDIN_JOURNAL;
const role = process.env.STANDIN_ROLE ?? "root";
const original = { ...fs };
let cache = { size: -1, state: {} };

fs.mkdirSync = (input, options) => {
  const path = inside(input);
  create(path);
  const existed = original.existsSync(path);
  const result = original.mkdirSync(path, options);
  if (!existed) record(path);
  return result;
};
fs.writeFileSync = (input, ...args) => {
  const path = inside(input);
  const existed = original.existsSync(path);
  if (existed) writable(path);
  else create(path);
  const result = original.writeFileSync(path, ...args);
  if (!existed) record(path);
  return result;
};
fs.rmSync = (input, options) => {
  const path = inside(input);
  remove(path);
  return original.rmSync(path, options);
};
fs.chmodSync = (input, mode) => {
  const path = inside(input);
  if (role !== "root" && info(path).owner === "root")
    throw new Error(`PERMISSION MODEL: chmod denied ${path}`);
  return original.chmodSync(path, mode);
};
fs.cpSync = (inputSource, inputDestination, options) => {
  const source = inside(inputSource);
  const destination = inside(inputDestination);
  const copied = [];
  checkCopy(source, destination, copied);
  const result = original.cpSync(source, destination, options);
  for (const path of copied) if (!original.lstatSync(path).isSymbolicLink()) record(path);
  return result;
};
fs.readFileSync = (input, ...args) => {
  const path = resolve(input instanceof URL ? fileURLToPath(input) : String(input));
  if (path.startsWith(`${root}/`)) readable(path);
  return original.readFileSync(input, ...args);
};
process.getuid = () => (role === "root" ? 0 : 1000);
syncBuiltinESMExports();

function inside(input) {
  const path = resolve(String(input));
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`OUTSIDE FIXTURE: ${path}`);
  return path;
}

// The journal only grows: its size identifies the replayed state.
function info(path) {
  const size = original.statSync(journal).size;
  if (size !== cache.size)
    cache = { size, state: replayState(parseJournal(original.readFileSync(journal, "utf8"))) };
  return stateEntry(cache.state, path);
}

function readable(path) {
  if (role === "root") return;
  let parent = dirname(path);
  while (parent.startsWith(`${root}/`)) {
    const entry = info(parent);
    if (!(entry.mode & (entry.owner === "root" ? 0o010 : 0o100)))
      throw new Error(`PERMISSION MODEL: search denied ${parent} for ${path}`);
    parent = dirname(parent);
  }
  const entry = info(path);
  if (!(entry.mode & (entry.owner === "root" ? 0o040 : 0o400)))
    throw new Error(`PERMISSION MODEL: read denied ${path}`);
}

function writable(path) {
  if (role === "root") return;
  const entry = info(path);
  if (entry.immutable || !(entry.mode & (entry.owner === "root" ? 0o020 : 0o200)))
    throw new Error(`PERMISSION MODEL: write denied ${path}`);
}

function create(path) {
  if (original.existsSync(path)) return;
  let parent = dirname(path);
  while (!original.existsSync(parent)) parent = dirname(parent);
  writable(parent);
}

function record(path) {
  const mode = (original.statSync(path).mode & 0o7777).toString(8);
  original.appendFileSync(journal, `create\t${role}\t${mode}\t${path}\n`);
}

function remove(path) {
  if (!original.existsSync(path)) return;
  if (role !== "root") {
    writable(dirname(path));
    const entry = info(path);
    if (entry.immutable || (info(dirname(path)).mode & 0o1000 && entry.owner === "root"))
      throw new Error(`PERMISSION MODEL: removal denied ${path}`);
  }
  if (original.lstatSync(path).isDirectory())
    for (const name of original.readdirSync(path)) remove(join(path, name));
}

function checkCopy(source, destination, copied) {
  readable(source);
  const existed = original.existsSync(destination);
  if (original.lstatSync(source).isDirectory()) {
    if (!existed) {
      create(destination);
      copied.push(destination);
    }
    for (const name of original.readdirSync(source))
      checkCopy(join(source, name), join(destination, name), copied);
  } else {
    if (existed) writable(destination);
    else create(destination);
    copied.push(destination);
  }
}
