import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { readMachineId } from "../../src/code/machine-id.js";
import { listSessionRecords } from "../../src/code/session-file.js";
import { makeSink, type Sink, writeConfig } from "../helpers.js";
import {
  type AlignfirstStub,
  type FakeAgent,
  installFakeAgent,
  writeAlignfirstStub,
} from "../stand-ins.js";

const ALIGNDEV_BIN = fileURLToPath(new URL("../../bin/aligndev.mjs", import.meta.url));

let dir: string;
let plans: string;
let home: string;
let fake: FakeAgent;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aligndev-catchup-"));
  plans = join(dir, ".plans");
  mkdirSync(plans);
  home = join(dir, "home");
  writeConfig(home, { code: { harness: "claude" } });
  fake = installFakeAgent(
    dir,
    "claude",
    `printf '%s' '{"type":"result","result":"done","session_id":"session-1"}'`,
  );
  env = { PATH: fake.path, HOME: home };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("catchup launch", () => {
  it("loads history once, then starts one protocol with the literal file message", async () => {
    const message = "Investigate `code` and $(literal) with '$value'.\n";
    writeFileSync(join(dir, "message.md"), message);
    const stub = writeAlignfirstStub(dir, dir);
    expect(
      await run(
        ["new", "--catchup", "--ticket", "29", "--protocol", "aad", "--message-file", "message.md"],
        stub,
      ),
    ).toBe(0);
    expect(stub.invocations().filter((line) => line.includes("--catchup"))).toEqual([
      "ticket 29 --catchup",
    ]);
    const { prompt } = fake.received();
    expect(prompt).toContain("Catch-up of ticket 29");
    expect(prompt).toContain("alignfirst guide aad");
    expect(prompt.endsWith(message)).toBe(true);
    expect(listSessionRecords(plans, readMachineId(home))[0].frontmatter.command).toContain(
      '--message-file "message.md"',
    );
  });

  it("reads stdin before ticket inference and passes shell-sensitive text exactly", () => {
    const message = "Read .plans/29/A1-spec.md\n`code` $(literal) \"$value\" 'quote' é\n";
    const stub = writeAlignfirstStub(dir, dir);
    const result = spawnSync(
      process.execPath,
      [ALIGNDEV_BIN, "code", "new", "--catchup", "--message-file", "-"],
      { cwd: dir, env: { ...env, PATH: `${dir}:${env.PATH}` }, input: message, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(stub.invocations()).toContain("ticket 29 --catchup");
    expect(fake.received().prompt.endsWith(message)).toBe(true);
  });

  it.each([
    ["--catchup"],
    ["--message", "one", "--message-file", "message.md"],
    ["--message-file", "missing.md"],
  ])("rejects %j before creating a session", async (...args) => {
    writeFileSync(join(dir, "message.md"), "two");
    expect(await run(["new", ...args])).toBe(1);
    expect(listSessionRecords(plans, readMachineId(home))).toEqual([]);
  });

  it("aborts before launching or creating a session when catchup fails", async () => {
    const stderr = makeSink();
    const stub = writeAlignfirstStub(dir, dir, {
      catchup: { stderr: "ticket unavailable", status: 1 },
    });
    expect(await run(["new", "--catchup", "--ticket", "29"], stub, stderr)).toBe(1);
    expect(stderr.text()).toContain("ticket unavailable");
    expect(listSessionRecords(plans, readMachineId(home))).toEqual([]);
  });
});

function run(
  args: string[],
  stub: AlignfirstStub = writeAlignfirstStub(dir, dir),
  stderr: Sink = makeSink(),
): Promise<number> {
  return main({
    argv: ["node", "aligndev", "code", ...args],
    cwd: dir,
    env,
    home,
    alignfirstCommand: stub.command,
    stdout: makeSink(),
    stderr,
  });
}
