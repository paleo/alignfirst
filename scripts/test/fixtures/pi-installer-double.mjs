import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const config = JSON.parse(readFileSync(process.env.PI_INSTALLER_FIXTURE, "utf8"));
const [command, ...args] = process.argv.slice(2);

try {
  dispatch();
} catch (error) {
  console.error(`[installer double ${command}] ${error.message}`);
  process.exitCode = 1;
}

function dispatch() {
  assert(isAbsolute(config.root));
  for (const path of [
    config.prefix,
    config.opt,
    config.bin,
    config.generator,
    config.systemNode,
    config.tmp,
    config.log,
    config.packageRoot,
    config.launcher,
  ])
    within(config.root, path);
  appendFileSync(config.log, `${JSON.stringify({ command, args })}\n`);
  switch (command) {
    case "id":
      assert.deepEqual(args, ["-u"]);
      console.log("0");
      return;
    case "lsattr":
      assert.deepEqual(args, ["-d", config.prefix]);
      assert(lstatSync(config.prefix).isDirectory());
      console.log(`----i--------- ${config.prefix}`);
      return;
    case "mktemp": {
      assert.deepEqual(args, []);
      assert.equal(process.env.TMPDIR, config.tmp);
      const path = join(config.tmp, `launcher-${randomUUID()}`);
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      console.log(path);
      return;
    }
    case "system-node": {
      assert.deepEqual(args, [config.generator, config.packageRoot, config.prefix]);
      const child = spawnSync(process.execPath, ["--import", config.adapter, ...args], {
        env: process.env,
        cwd: process.cwd(),
        stdio: "inherit",
        timeout: 10000,
      });
      if (child.error) throw child.error;
      assert.equal(child.signal, null, "generator must not be killed");
      process.exitCode = child.status ?? 1;
      return;
    }
    case "install":
      install();
      return;
    case "rm":
      assert.equal(args.length, 3);
      assert.deepEqual(args.slice(0, 2), ["-f", "--"]);
      temporary(args[2]);
      unlinkSync(args[2]);
      return;
    default:
      throw new Error(`Unexpected command or hostile runtime: ${command}`);
  }
}

function install() {
  if (args[0] === "-d") {
    assert.deepEqual(args, ["-d", "-o", "root", "-g", "root", "-m", "755", config.bin]);
    mkdirSync(config.bin, { recursive: true, mode: 0o755 });
    chmodSync(config.bin, 0o755);
    return;
  }
  assert.equal(args.length, 8);
  assert.deepEqual(args.slice(0, 6), ["-o", "root", "-g", "root", "-m", "755"]);
  temporary(args[6]);
  assert.equal(args[7], config.launcher);
  assert(lstatSync(args[6]).isFile());
  copyFileSync(args[6], args[7]);
  chmodSync(args[7], 0o755);
}

function temporary(path) {
  within(config.tmp, path);
  assert.equal(dirname(path), config.tmp);
  assert.match(path.slice(config.tmp.length + 1), /^launcher-[0-9a-f-]+$/u);
}

function within(root, path) {
  assert.equal(resolve(path), path);
  assert(path.startsWith(`${root}/`), `Path outside owned fixture: ${path}`);
}
