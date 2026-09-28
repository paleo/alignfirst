import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli.js";
import { listSessionRecords } from "../../src/code/session-file.js";
import { writeConfig } from "../helpers.js";

const ALDEV_BIN = fileURLToPath(new URL("../../bin/aldev.mjs", import.meta.url));

let dir: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aldev-catchup-"));
  mkdirSync(join(dir, ".plans"));
  home = join(dir, "home");
  writeConfig(home, { code: { agent: "claude" } });
  env = { PATH: dir, HOME: home };
  writeFileSync(
    join(dir, "claude"),
    `#!${process.execPath}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  require("node:fs").writeFileSync("received.txt", prompt);
  process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "session-1" }));
});
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "alignfirst"),
    `#!${process.execPath}
require("node:fs").writeFileSync("catchup-args.json", JSON.stringify(process.argv.slice(2)));
process.stdout.write("- .plans/29/A1-spec.md (40000 bytes)\\nContent omitted: total limit exceeded.\\n");
`,
    { mode: 0o755 },
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("catchup launch", () => {
  it("loads history once, then starts one protocol with the literal file message", async () => {
    const message = "Investigate `code` and $(literal) with '$value'.\n";
    writeFileSync(join(dir, "message.md"), message);
    expect(
      await run([
        "new",
        "--catchup",
        "--ticket",
        "29",
        "--protocol",
        "aad",
        "--message-file",
        "message.md",
      ]),
    ).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "catchup-args.json"), "utf8"))).toEqual([
      "ticket",
      "29",
      "--catchup",
    ]);
    const prompt = readFileSync(join(dir, "received.txt"), "utf8");
    expect(prompt).toContain("Content omitted: total limit exceeded.");
    expect(prompt).toContain("Run `alignfirst guide aad`");
    expect(prompt.endsWith(message)).toBe(true);
    expect(listSessionRecords(dir)[0].frontmatter.command).toContain('--message-file "message.md"');
  });

  it("summarizes without a message and rejects catchup on resume", async () => {
    expect(await run(["new", "--catchup", "--ticket", "29"])).toBe(0);
    expect(readFileSync(join(dir, "received.txt"), "utf8")).toContain(
      "Summarize the ticket history briefly",
    );
    rmSync(join(dir, "catchup-args.json"));
    expect(await run(["resume", "session-1", "--catchup"])).toBe(1);
    expect(existsSync(join(dir, "catchup-args.json"))).toBe(false);
  });

  it("reads stdin before ticket inference and passes shell-sensitive text exactly", () => {
    const message = "Read .plans/29/A1-spec.md\n`code` $(literal) \"$value\" 'quote' é\n";
    const result = spawnSync(
      process.execPath,
      [ALDEV_BIN, "code", "new", "--catchup", "--message-file", "-"],
      {
        cwd: dir,
        env,
        input: message,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "catchup-args.json"), "utf8"))).toEqual([
      "ticket",
      "29",
      "--catchup",
    ]);
    expect(readFileSync(join(dir, "received.txt"), "utf8").endsWith(message)).toBe(true);
  });

  it("preserves a quoted Bash heredoc without evaluating substitutions", () => {
    const message =
      "Read .plans/29/A1-spec.md\n`printf altered` $(printf altered) \"$PATH\" 'quote'\n";
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        '"$1" "$2" code new --catchup --message-file - <<\'ALDEV_MESSAGE\'\n' +
          message +
          "ALDEV_MESSAGE\n",
        "aldev-test",
        process.execPath,
        ALDEV_BIN,
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "received.txt"), "utf8").endsWith(message)).toBe(true);
  });

  it.each([
    ["--catchup"],
    ["--protocol", "catchup", "--ticket", "29"],
    ["--message", "one", "--message-file", "missing.md"],
    ["--message-file", "missing.md"],
  ])("rejects invalid inputs before creating a session: %j", async (...args) => {
    expect(await run(["new", ...args])).toBe(1);
    expect(listSessionRecords(dir)).toEqual([]);
  });

  it("validates empty file content and protocol requirements", async () => {
    writeFileSync(join(dir, "empty.md"), " \n");
    expect(await run(["new", "--message-file", "empty.md"])).toBe(1);
    expect(
      await run([
        "new",
        "--catchup",
        "--ticket",
        "29",
        "--protocol",
        "aad",
        "--message-file",
        "empty.md",
      ]),
    ).toBe(1);
    expect(listSessionRecords(dir)).toEqual([]);
  });

  it("aborts before launching or creating a session when catchup fails", async () => {
    writeFileSync(
      join(dir, "alignfirst"),
      `#!${process.execPath}\nprocess.stderr.write("ticket unavailable"); process.exit(1);`,
      { mode: 0o755 },
    );
    let error = "";
    expect(
      await main({
        argv: ["node", "aldev", "code", "new", "--catchup", "--ticket", "29"],
        cwd: dir,
        env,
        home,
        stderr: {
          write(text) {
            error += text;
          },
        },
      }),
    ).toBe(1);
    expect(error).toContain("ticket unavailable");
    expect(listSessionRecords(dir)).toEqual([]);
  });
});

function run(args: string[]): Promise<number> {
  return main({
    argv: ["node", "aldev", "code", ...args],
    cwd: dir,
    env,
    home,
    stdout: { write() {} },
    stderr: { write() {} },
  });
}
