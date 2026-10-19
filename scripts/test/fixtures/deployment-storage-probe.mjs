import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

// Native storage is not a public export. Inspect the pinned implementation in an isolated process.
const { AuthStorage } = await import(
  new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const fixtureRoot = process.env.DEPLOYMENT_FIXTURE_ROOT;
assert(fixtureRoot !== undefined, "Only run through the disposable deployment test harness");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent");
assert(realpathSync(agentDir).startsWith(`${realpathSync(fixtureRoot)}${sep}`));
const authPath = join(agentDir, "auth.json");
const lockPath = `${authPath}.lock`;

await main();

async function main() {
  const before = { type: "oauth", access: "fixture-old", refresh: "fixture-refresh", expires: 0 };
  writeFileSync(authPath, JSON.stringify({ "fixture-provider": before }), { mode: 0o600 });
  const storage = AuthStorage.create(authPath);
  if (process.argv[2] === "mutable") {
    let adjacentLockObserved = false;
    const next = { ...before, access: "fixture-new", expires: 123456 };
    await storage.modify("fixture-provider", async (current) => {
      assert.deepEqual(current, before);
      adjacentLockObserved = statSync(lockPath).isDirectory();
      return next;
    });
    const stored = JSON.parse(readFileSync(authPath, "utf8"))["fixture-provider"];
    console.log(
      JSON.stringify({
        adjacentLockObserved,
        credentialUpdated: stored.access === next.access && stored.expires === next.expires,
        lockRemoved: !existsSync(lockPath),
      }),
    );
    return;
  }
  assert.equal(process.argv[2], "permissions");
  try {
    chmodSync(authPath, 0o400);
    await assert.rejects(
      storage.modify("fixture-provider", async () => before),
      { code: "EACCES" },
    );
    assert(!existsSync(lockPath));
    chmodSync(authPath, 0o600);
    chmodSync(agentDir, 0o500);
    await assert.rejects(
      storage.modify("fixture-provider", async () => before),
      { code: "EACCES" },
    );
    console.log(
      JSON.stringify({
        fileWriteDenied: true,
        parentLockDenied: true,
        noLockRemains: !existsSync(lockPath),
      }),
    );
  } finally {
    chmodSync(agentDir, 0o700);
    chmodSync(authPath, 0o600);
  }
}
