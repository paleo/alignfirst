import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const registryPath = process.argv[2];
if (registryPath === undefined) throw new Error("Registry path is required");
const lockPath = `${registryPath}.lock`;
const claimPath = join(lockPath, `claim-${process.pid}-child.json`);
mkdirSync(lockPath, { mode: 0o700 });
writeFileSync(claimPath, `${JSON.stringify({ pid: process.pid, ticket: 1, token: "child" })}\n`, {
  mode: 0o600,
});
process.send?.("locked");
process.once("message", () => {
  rmSync(lockPath, { recursive: true });
  process.exit(0);
});
