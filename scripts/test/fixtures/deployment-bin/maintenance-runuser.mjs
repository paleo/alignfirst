import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { callRecord } from "../deployment-standins.mjs";

// The maintenance-core service step: checks the wrapper's exact service invocation and its private
// snapshots ("snapshot <json>" records), then runs the native recovery or simulates the service
// command. FIXTURE_OUTCOME=failure|signal ends it; FIXTURE_MUTATION changes settings or packages
// during the command, and failRecovery fails the recovery before it copies anything.
const root = process.env.STANDIN_ROOT;
const journal = process.env.STANDIN_JOURNAL;
const args = process.argv.slice(2);
const home = `${root}/home`;
const reviewedSettings = `${root}/admin/infra/openclaw/aligndev.settings.json`;

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function main() {
  appendFileSync(journal, callRecord("runuser", args));
  const command = serviceCommand();
  const recovery = isRecovery(command);
  if (!recovery && (command.length !== 1 || command[0] !== `${root}/service-command`))
    throw new Error("Unexpected service command");
  if (recovery) inside(command[6]);
  appendFileSync(journal, callRecord("service-command", []));
  writeFileSync(`${root}/service-ran`, "");
  recordSnapshots(recovery ? command[3] : undefined);
  const mutation =
    process.env.FIXTURE_MUTATION === undefined ? {} : JSON.parse(process.env.FIXTURE_MUTATION);
  if (recovery) {
    if (mutation.failRecovery) process.exit(1);
    const result = spawnSync(command[0], command.slice(1), {
      env: process.env,
      stdio: "inherit",
      timeout: 20_000,
    });
    process.exit(result.status ?? 1);
  }
  applyMutation(mutation);
  if (process.env.FIXTURE_OUTCOME === "signal") {
    process.kill(process.ppid, "SIGTERM");
    process.exit(143);
  }
  if (process.env.FIXTURE_OUTCOME === "failure") process.exit(42);
}

function serviceCommand() {
  const expected = [
    "-u",
    "fixture",
    "--",
    "env",
    `HOME=${home}`,
    "USER=fixture",
    "LOGNAME=fixture",
    "XDG_RUNTIME_DIR=/run/user/1000",
  ];
  if (
    expected.some((value, index) => args[index] !== value) ||
    !args[8]?.startsWith("PATH=/usr/bin:/opt/fixture/bin:/bin:") ||
    args.slice(9, 13).join("\n") !== ["bash", "-c", 'cd "$HOME" && exec "$@"', "bash"].join("\n")
  )
    throw new Error("Unexpected runuser");
  return args.slice(13);
}

function isRecovery(command) {
  return (
    command.length === 7 &&
    command[0] === process.execPath &&
    command[1] === `${root}/opt/fixture/libexec/deployment-policy.mjs` &&
    command[2] === "recover" &&
    command[3].startsWith(`${root}/tmp.`) &&
    command[3].endsWith("/settings.json") &&
    command[4] === home &&
    command[5] === `${home}/.alignfirst/aligndev.settings.json`
  );
}

function recordSnapshots(recoverySettings) {
  for (const name of readdirSync(root).filter((entry) => entry.startsWith("tmp."))) {
    const directory = `${root}/${name}`;
    if (!statSync(directory).isDirectory()) continue;
    if (`${directory}/settings.json` === recoverySettings) {
      if ((statSync(directory).mode & 0o022) !== 0)
        throw new Error("Recovery settings directory is writable");
      if (readFileSync(recoverySettings, "utf8") !== readFileSync(reviewedSettings, "utf8"))
        throw new Error("Recovery settings differ from review");
      continue;
    }
    if (statSync(directory).uid !== process.getuid())
      throw new Error("Snapshot owner differs from wrapper owner");
    if ((statSync(directory).mode & 0o077) !== 0)
      throw new Error("Snapshot directory is not private");
    for (const file of readdirSync(directory)) {
      if ((statSync(`${directory}/${file}`).mode & 0o077) !== 0)
        throw new Error("Snapshot file is not private");
      appendFileSync(journal, `snapshot\t${readFileSync(`${directory}/${file}`, "utf8").trim()}\n`);
    }
  }
}

function applyMutation(mutation) {
  const nativeSettings = `${home}/.pi/agent/settings.json`;
  if (mutation.remove) rmSync(nativeSettings);
  else if (mutation.malformed) writeFileSync(nativeSettings, "{invalid");
  else if (mutation.settings !== undefined)
    writeFileSync(nativeSettings, JSON.stringify(mutation.settings));
  if (mutation.packageLink) {
    inside(mutation.packageLink);
    symlinkSync(mutation.packageLink, `${home}/.npm-system-global/bin/tool`);
  }
}

function inside(path) {
  if (!path.startsWith(`${root}/`)) throw new Error(`OUTSIDE FIXTURE: ${path}`);
}
