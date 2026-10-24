import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { host, jobFrom, waitFor, waitJob } from "../host-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packedRoot = mkdtempSync(join(tmpdir(), "pi-background-integration-pack-"));
const background = join(packedRoot, "package");
const codingAgent = fileURLToPath(new URL("../fixtures/coding-agent.mjs", import.meta.url));

beforeAll(() => {
  execFileSync(
    "npm",
    [
      "run",
      "build",
      "--workspace",
      "@alignfirst/docmap",
      "--workspace",
      "alignfirst",
      "--workspace",
      "aligndev",
      "--workspace",
      "@alignfirst/pi-background",
    ],
    { cwd: root, stdio: "pipe" },
  );
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", packedRoot], {
      cwd: join(root, "packages/pi-background"),
      encoding: "utf8",
    }),
  );
  const first = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("filename" in first) ||
    typeof first.filename !== "string"
  )
    throw new Error("Missing packed background artifact");
  execFileSync("tar", ["-xzf", join(packedRoot, first.filename), "-C", packedRoot]);
}, 60000);

afterAll(() => rmSync(packedRoot, { recursive: true, force: true }));

describe("real AlignDev CLI through manifest-loaded background in public Pi runtime", () => {
  it("retains exact companion files for out-of-order worktrees, quiet results and questions", async () => {
    const h = await fixture();
    try {
      const first = await h.launch("slow", h.project);
      const second = await h.launch("question", h.worktree);
      expect(first.id).not.toBe(second.id);
      writeFileSync(second.gate, "go");
      const secondTerminal = await waitJob(h, second.id);
      expect(
        secondTerminal.status,
        JSON.stringify(await h.call({ action: "output", id: second.id })),
      ).toBe("succeeded");
      expect(jobFrom(await h.call({ action: "status", id: first.id })).status).toBe("running");
      const secondResult = h.status(second.key, h.worktree);
      expect(secondResult).toContain("FINAL:question");
      expect(secondResult).not.toContain("PRIVATE-INTERNAL");
      writeFileSync(first.gate, "go");
      expect((await waitJob(h, first.id)).status).toBe("succeeded");
      const firstResult = h.status(first.key, h.project);
      expect(firstResult).toContain("FINAL:slow");
      expect(firstResult).not.toContain("FINAL:question");
      const paths = [firstResult, secondResult].map(
        (text) => /^sessionFile: (.+)$/m.exec(text)?.[1],
      );
      expect(paths[0]).not.toBe(paths[1]);
      for (const [index, path] of paths.entries()) {
        if (path === undefined) throw new Error("No exact session file");
        expect(path.startsWith(h.companion)).toBe(true);
        expect(readFileSync(path, "utf8")).toContain("PRIVATE-INTERNAL");
        expect(
          h.cli(["code", "status", path, "--result"], index === 0 ? h.project : h.worktree),
        ).toBe(index === 0 ? firstResult : secondResult);
      }
      for (const job of [first, second]) {
        const output = await h.call({ action: "output", id: job.id });
        expect(output).toHaveProperty("output");
        expect(JSON.stringify(output)).not.toContain("PRIVATE-INTERNAL");
        expect(JSON.stringify(output)).not.toContain("FINAL:");
      }
      expect(JSON.stringify(h.requests)).not.toContain("PRIVATE-INTERNAL");
      expect(h.extensionErrors).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it.each(["failure", "auth"])("reports %s once without a coding retry", async (mode) => {
    const h = await fixture();
    try {
      const job = await h.launch(mode, h.project);
      writeFileSync(job.gate, "go");
      const terminal = await waitJob(h, job.id);
      expect(terminal.status).toBe("failed");
      expect(terminal.exitCode).toBe(mode === "auth" ? 2 : 1);
      expect(h.status(job.key, h.project)).toContain(
        mode === "auth" ? "exitReason: auth_required" : "exitReason: error",
      );
      expect(await h.call({ action: "list" })).toMatchObject({
        jobs: [{ id: job.id, status: "failed" }],
      });
    } finally {
      await h.close();
    }
  });

  it.each(["stop", "reload", "new", "resume", "fork", "quit"])(
    "%s gives the CLI time to seal termination and reaps its resistant coding child",
    async (operation) => {
      const h = await fixture();
      try {
        await h.runtime.session.prompt("seed");
        const session = h.runtime.session.sessionFile;
        const target = h.runtime.session.sessionManager
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "user");
        if (!session || !target) throw new Error("Missing persisted fixture");
        const job = await h.launch("cancel", h.project);
        await waitFor(() => existsSync(`${job.gate}.pid`));
        const pid = Number(readFileSync(`${job.gate}.pid`, "utf8"));
        if (operation === "stop")
          expect(jobFrom(await h.call({ action: "stop", id: job.id })).status).toBe("cancelled");
        else if (operation === "reload") await h.runtime.session.reload();
        else if (operation === "new") await h.runtime.newSession();
        else if (operation === "resume") await h.runtime.switchSession(session);
        else if (operation === "fork") await h.runtime.fork(target.id);
        else await h.runtime.dispose();
        expect(h.status(job.key, h.project)).toContain("exitReason: terminated");
        expect(alive(pid)).toBe(false);
        expect(h.extensionErrors).toEqual([]);
      } finally {
        await h.close();
      }
    },
    15000,
  );
});

async function fixture() {
  const h = await host({ fileExtensions: [background], persisted: true });
  const home = join(h.cwd, "home");
  const bin = join(h.cwd, "bin");
  mkdirSync(bin);
  for (const name of ["alignfirst", "aligndev"])
    symlinkSync(join(root, `packages/${name}/bin/${name}.mjs`), join(bin, name));
  writeFileSync(
    join(bin, "pi"),
    `#!${process.execPath}\nimport ${JSON.stringify(codingAgent)};\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "npx"), "#!/bin/sh\necho 'UNINTENDED REGISTRY FALLBACK' >&2\nexit 99\n", {
    mode: 0o755,
  });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  // Model a direct CLI launch, not the npm lifecycle running this suite.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("npm_")) vi.stubEnv(key, undefined);
  }
  for (const key of ["NODE_OPTIONS", "NODE_PATH"]) vi.stubEnv(key, undefined);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(h.cwd, "gitconfig"));
  writeFileSync(join(h.cwd, "gitconfig"), "");
  writeJson(join(home, ".alignfirst/aligndev.settings.json"), {
    code: { profile: "pi-fixture", profiles: { "pi-fixture": { agent: "pi" } } },
  });
  const project = join(h.cwd, "project");
  const worktree = join(h.cwd, "worktree");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main", project);
  git(
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  );
  git("-C", project, "worktree", "add", "--quiet", "-b", "fixture-worktree", worktree);
  mkdirSync(join(project, ".plans"));
  symlinkSync(join(project, ".plans"), join(worktree, ".plans"), "dir");
  const companion = join(home, "companion");
  writeJson(join(home, ".alignfirst/companions/registry.json"), {
    projects: {
      [project]: { dir: companion, items: { ".plans": "project", _aligndev: "companion" } },
    },
  });
  const cli = (args: string[], cwd: string) =>
    execFileSync(join(bin, "aligndev"), args, { cwd, encoding: "utf8" });
  expect(cli(["--version"], project).trim()).toBe(
    JSON.parse(readFileSync(join(root, "packages/aligndev/package.json"), "utf8")).version,
  );
  expect(execFileSync("which", ["alignfirst"], { encoding: "utf8" }).trim()).toBe(
    join(bin, "alignfirst"),
  );
  return {
    ...h,
    project,
    worktree,
    companion,
    cli,
    status: (key: string, cwd: string) => cli(["code", "status", "--meta", key, "--result"], cwd),
    async launch(mode: string, cwd: string) {
      const key = `${mode}-${crypto.randomUUID()}`;
      const gate = join(h.cwd, key);
      const job = jobFrom(
        await h.call({
          action: "start",
          cwd,
          command: `aligndev code new --quiet --meta '${key}' -m 'CASE:${mode}:${gate}'`,
        }),
      );
      return { ...job, key, gate };
    },
  };
}

function writeJson(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function alive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0] !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
