import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { prefix } = JSON.parse(fs.readFileSync(process.env.PI_INSTALLER_FIXTURE, "utf8"));
const originalLstat = fs.lstatSync;

// Only the generator child simulates root ownership; modes, symlinks and I/O stay real.
fs.lstatSync = function lstatSync(path, options) {
  const stat = originalLstat(path, options);
  if (stat === undefined) return stat;
  const absolute = resolve(path instanceof URL ? fileURLToPath(path) : path.toString());
  if (absolute === prefix || absolute.startsWith(`${prefix}/`))
    Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
  return stat;
};
syncBuiltinESMExports();
