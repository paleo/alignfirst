import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { findStoppedRebase, resolveStoppedRebase } from "../src/plans/rebase.js";
import { configureGit, git, makeSink, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

interface Fixture {
  root: string;
  product: string;
  clone: string;
  other: string;
  remote: string;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["résumé.md", " leading.md", "line\nbreak.md", "[spec]*.md", "tab\tfile.md"])(
  "preserves independently added documents named %j exactly, locally and remotely",
  async (name) => {
    const fixture = await makeFixture();
    const path = `product-plans/80/${name}`;
    write(fixture.clone, path, "local document\n\n");
    write(fixture.other, path, "remote document\n\n");
    publishOther(fixture);

    const result = await runMain(["sync"], { cwd: fixture.product });

    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.clone, path), "utf8")).toBe("remote document\n\n");
    const files = readdirSync(join(fixture.clone, "product-plans/80"));
    expect(files).toHaveLength(2);
    const copy = files.find((file) => file !== name);
    if (copy === undefined) throw new Error("Expected a separate local document.");
    expect(readFileSync(join(fixture.clone, "product-plans/80", copy), "utf8")).toBe(
      "local document\n\n",
    );
    expect(remoteContent(fixture, path)).toBe("remote document\n\n");
    expect(remoteContent(fixture, `product-plans/80/${copy}`)).toBe("local document\n\n");
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  },
);

it("preserves both original destinations of a real rename/rename conflict", async () => {
  const common = Array.from({ length: 30 }, (_, index) => `shared line ${index}\n`).join("");
  const fixture = await makeFixture({ "product-plans/80/original.md": `${common}base\n` });
  git(fixture.clone, "mv", "product-plans/80/original.md", "product-plans/80/local.md");
  write(fixture.clone, "product-plans/80/local.md", `${common}local\n`);
  git(fixture.other, "mv", "product-plans/80/original.md", "product-plans/80/remote.md");
  write(fixture.other, "product-plans/80/remote.md", `${common}remote\n`);
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(readdirSync(join(fixture.clone, "product-plans/80"))).toEqual(["local.md", "remote.md"]);
  for (const version of ["local", "remote"]) {
    const path = `product-plans/80/${version}.md`;
    expect(readFileSync(join(fixture.clone, path), "utf8")).toBe(`${common}${version}\n`);
    expect(remoteContent(fixture, path)).toBe(`${common}${version}\n`);
  }
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it.each(["local", "remote"])(
  "preserves the edited document when %s deletes it",
  async (deleted) => {
    const path = "product-plans/80/spec.md";
    const fixture = await makeFixture({ [path]: "base\n" });
    git(deleted === "local" ? fixture.clone : fixture.other, "rm", path);
    write(deleted === "local" ? fixture.other : fixture.clone, path, "edited\n");
    publishOther(fixture);

    const result = await runMain(["sync"], { cwd: fixture.product });

    expect(result.code, result.stderr).toBe(0);
    expect(remoteContent(fixture, path)).toBe("edited\n");
    expect(readFileSync(join(fixture.clone, path), "utf8")).toBe("edited\n");
  },
);

it("keeps renamed plans paired with summaries and updates local document references", async () => {
  const fixture = await makeFixture();
  const plan = "product-plans/80/A1-main-plan.md";
  const summary = "product-plans/80/A1-main-plan.summary.md";
  write(fixture.other, plan, "published plan\n");
  write(fixture.other, summary, "published summary\n");
  publishOther(fixture);
  write(fixture.clone, plan, "local plan\n");
  write(fixture.clone, summary, "Summary of [plan](A1-main-plan.md).\n");
  write(
    fixture.clone,
    "product-plans/80/A2-AAD.summary.md",
    "Read `.plans/80/A1-main-plan.md` and [summary](./A1-main-plan.summary.md).\n",
  );

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, plan)).toBe("published plan\n");
  expect(remoteContent(fixture, summary)).toBe("published summary\n");
  expect(remoteContent(fixture, "product-plans/80/A3-main-plan.md")).toBe("local plan\n");
  expect(remoteContent(fixture, "product-plans/80/A3-main-plan.summary.md")).toBe(
    "Summary of [plan](A3-main-plan.md).\n",
  );
  expect(remoteContent(fixture, "product-plans/80/A2-AAD.summary.md")).toBe(
    "Read `.plans/80/A3-main-plan.md` and [summary](./A3-main-plan.summary.md).\n",
  );
});

it("accepts clean edits to an existing document", async () => {
  const path = "product-plans/80/spec.md";
  const middle = Array.from({ length: 20 }, (_, index) => `paragraph ${index}\n`).join("");
  const fixture = await makeFixture({ [path]: `start\n${middle}end\n` });
  write(fixture.clone, path, `local start\n${middle}end\n`);
  write(fixture.other, path, `start\n${middle}remote end\n`);
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe(`local start\n${middle}remote end\n`);
  expect(readdirSync(join(fixture.clone, dirname(path)))).toEqual([basename(path)]);
});

it("does not restore an unrelated document deleted upstream while rewriting references", async () => {
  const fixture = await makeFixture({ "product-plans/80/obsolete.md": "obsolete\n" });
  git(fixture.other, "rm", "product-plans/80/obsolete.md");
  write(fixture.other, "product-plans/80/spec.md", "remote spec\n");
  publishOther(fixture);
  write(fixture.clone, "product-plans/80/spec.md", "local spec\n");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(fixture.clone, "product-plans/80/obsolete.md"))).toBe(false);
  expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("obsolete.md");
});

it("stops before a later local edit can be replayed onto the published document", async () => {
  const fixture = await makeFixture();
  const path = "product-plans/80/spec.md";
  const middle = Array.from({ length: 20 }, (_, index) => `paragraph ${index}\n`).join("");
  write(fixture.clone, path, `local\n${middle}old tail\n`);
  git(fixture.clone, "add", "-A");
  git(fixture.clone, "commit", "--quiet", "-m", "local spec");
  write(fixture.clone, path, `local\n${middle}new tail\n`);
  commitLocal(fixture, "sync");
  const localBefore = git(fixture.clone, "rev-parse", "HEAD");
  write(fixture.other, path, `remote\n${middle}old tail\n`);
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("a later local commit edits it");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
  expect(result.stderr).toContain("back to its state before the pull");
  expect(remoteContent(fixture, path)).toBe(`remote\n${middle}old tail\n`);
  expect(readdirSync(join(fixture.clone, "product-plans/80"))).toEqual(["spec.md"]);
});

it("allocates a free local name without overwriting an existing copy", async () => {
  const fixture = await makeFixture({ "product-plans/80/spec-local-2.md": "existing copy\n" });
  write(fixture.clone, "product-plans/80/spec.md", "local\n");
  write(fixture.other, "product-plans/80/spec.md", "remote\n");
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, "product-plans/80/spec-local-2.md")).toBe("existing copy\n");
  expect(remoteContent(fixture, "product-plans/80/spec-local-3.md")).toBe("local\n");
});

it("stops when a later local document would refer to the wrong version", async () => {
  const fixture = await makeFixture();
  write(fixture.clone, "product-plans/80/spec.md", "local spec\n");
  git(fixture.clone, "add", "-A");
  git(fixture.clone, "commit", "--quiet", "-m", "local spec");
  write(fixture.clone, "product-plans/80/plan.md", "Read [spec](spec.md).\n");
  commitLocal(fixture, "sync");
  const localBefore = git(fixture.clone, "rev-parse", "HEAD");
  write(fixture.other, "product-plans/80/spec.md", "remote spec\n");
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("later local commit references a renamed document");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
  expect(result.stderr).toContain("back to its state before the pull");
});

it("updates references in an earlier local document when its spec is renamed", async () => {
  const fixture = await makeFixture();
  write(fixture.clone, "product-plans/80/plan.md", "Read [spec](spec.md).\n");
  git(fixture.clone, "add", "-A");
  git(fixture.clone, "commit", "--quiet", "-m", "local plan");
  write(fixture.clone, "product-plans/80/spec.md", "local spec\n");
  write(fixture.other, "product-plans/80/spec.md", "remote spec\n");
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, "product-plans/80/plan.md")).toBe(
    "Read [spec](spec-local-2.md).\n",
  );
});

it("stops an unsupported directory/file conflict without pushing", async () => {
  const fixture = await makeFixture();
  write(fixture.clone, "product-plans/80/spec.md", "local file\n");
  commitLocal(fixture, "local file");
  const localBefore = git(fixture.clone, "rev-parse", "HEAD");
  write(fixture.other, "product-plans/80/spec.md/child.md", "remote child\n");
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Resolve the rebase manually");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
  expect(result.stderr).toContain("back to its state before the pull");
  expect(readFileSync(join(fixture.clone, "product-plans/80/spec.md"), "utf8")).toBe(
    "local file\n",
  );
});

it("aborts the rebase when a conflicted filename cannot be decoded losslessly", async () => {
  const fixture = await makeFixture();
  for (const [repo, content] of [
    [fixture.clone, "local\n"],
    [fixture.other, "remote\n"],
  ]) {
    const dir = join(repo, "product-plans/80");
    mkdirSync(dir, { recursive: true });
    const path = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0xff]), Buffer.from(".md")]);
    writeFileSync(path, content);
  }
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("non-UTF-8 Git output");
  expect(result.stderr).toContain("back to its state before the pull");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
});

it("consolidates repeated sync edits and preserves the final local session contents", async () => {
  const path = "product-plans/78/_aligndev/x.md";
  const fixture = await makeFixture({ [path]: "base\n" });
  for (const content of ["first\n", "second\n", "final local\n"]) {
    write(fixture.clone, path, content);
    commitLocal(fixture, "sync");
  }
  write(fixture.other, path, "remote\n");
  publishOther(fixture);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe("remote\n");
  expect(remoteContent(fixture, "product-plans/78/_aligndev/x-local-2.md")).toBe("final local\n");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it("consolidates sync-only history into one commit with the same tree", async () => {
  const fixture = await makeFixture();
  const base = git(fixture.clone, "rev-parse", "@{u}");
  for (const content of ["first", "second", "third"]) {
    write(fixture.clone, "note.md", content);
    commitLocal(fixture, "sync");
  }
  const tree = git(fixture.clone, "rev-parse", "HEAD^{tree}");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
  expect(git(fixture.clone, "rev-parse", "HEAD^{tree}")).toBe(tree);
});

it("keeps a mixed manual history unchanged", async () => {
  const fixture = await makeFixture();
  for (const message of ["sync", "manual change", "sync"]) {
    write(fixture.clone, "note.md", message + Math.random());
    commitLocal(fixture, message);
  }
  const head = git(fixture.clone, "rev-parse", "HEAD");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(head);
});

it("drops a net-empty sync history back to the upstream", async () => {
  const fixture = await makeFixture();
  const base = git(fixture.clone, "rev-parse", "@{u}");
  write(fixture.clone, "note.md", "temporary");
  commitLocal(fixture, "sync");
  rmSync(join(fixture.clone, "note.md"));
  commitLocal(fixture, "sync");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(base);
  expect(result.stdout).toContain("nothing to send");
});

it.each(["product-plans/_aligndev/[run]*.running.md", "product-plans/78/_aligndev/run.running.md"])(
  "keeps running logs untracked until completion: %s",
  async (path) => {
    const fixture = await makeFixture();
    write(fixture.clone, path, `---\nstatus: running\n---\n${"transcript".repeat(200_000)}`);
    write(fixture.clone, "note.md", "other document");
    const result = await runMain(["sync"], { cwd: fixture.product });
    expect(result.code, result.stderr).toBe(0);
    expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(path);
    expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(path);
    expect(git(fixture.clone, "ls-files", "--cached")).not.toContain(path);
    const completed = path.replace(".running.md", ".md");
    write(fixture.clone, completed, "---\nstatus: succeeded\n---\nfinished\n");
    rmSync(join(fixture.clone, path));
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);
    expect(remoteContent(fixture, completed)).toBe("---\nstatus: succeeded\n---\nfinished\n");
  },
);

it("keeps an archived running log local too", async () => {
  const fixture = await makeFixture();
  const path = "product-plans/_archives/78/_aligndev/run.running.md";
  write(fixture.clone, path, "---\nstatus: running\n---\n");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(path);
});

it.each([
  ["product-plans/78/_aligndev/run.md", "---\nstatus: running\n---\n"],
  ["product-plans/78/run.running.md", "not a session log\n"],
])("sends files by name, not by content: %s", async (path, content) => {
  const fixture = await makeFixture();
  write(fixture.clone, path, content);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe(content);
});

it("continues syncing already-tracked running logs without migration", async () => {
  const path = "product-plans/78/_aligndev/run.md";
  const fixture = await makeFixture({ [path]: "---\nstatus: running\n---\nold\n" });
  write(fixture.clone, path, "---\nstatus: running\n---\nnew\n");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe("---\nstatus: running\n---\nnew\n");
});

it("keeps a running log local through automatic conflict resolution", async () => {
  const fixture = await makeFixture({ "product-plans/80/spec.md": "base\n" });
  const running = "product-plans/80/_aligndev/run.running.md";
  const content = "---\nstatus: running\n---\ntranscript\n";
  write(fixture.clone, running, content);
  write(fixture.clone, "product-plans/80/spec.md", "local\n");
  write(fixture.other, "product-plans/80/spec.md", "remote\n");
  publishOther(fixture);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe(running);
  expect(readFileSync(join(fixture.clone, running), "utf8")).toBe(content);
  expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(running);
});

it("leaves pending sync-message merges intact before Git's rebase", async () => {
  const fixture = await makeFixture();
  git(fixture.clone, "checkout", "--quiet", "-b", "side");
  write(fixture.clone, "side.md", "side\n");
  commitLocal(fixture, "sync");
  git(fixture.clone, "checkout", "--quiet", "main");
  write(fixture.clone, "main.md", "main\n");
  commitLocal(fixture, "sync");
  git(fixture.clone, "merge", "--quiet", "--no-ff", "-m", "sync", "side");
  const head = git(fixture.clone, "rev-parse", "HEAD");
  const beforeRebase = join(fixture.root, "before-rebase");
  const hook = join(fixture.clone, ".git/hooks/pre-rebase");
  writeFileSync(hook, `#!/bin/sh\ngit rev-parse HEAD > '${beforeRebase}'\n`);
  chmodSync(hook, 0o755);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(beforeRebase, "utf8").trim()).toBe(head);
});

it("does not retry an ordinary push rejection and releases the lock", async () => {
  const fixture = await makeFixture();
  const hook = join(fixture.remote, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  write(fixture.clone, "note.md", "local\n");
  const random = vi.spyOn(Math, "random");
  try {
    const result = await runMain(["sync"], { cwd: fixture.product });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git push failed");
    expect(random).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.clone, ".git/alignfirst-sync.lock"))).toBe(false);
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  } finally {
    random.mockRestore();
  }
});

it("stages only resolver paths and leaves an unrelated untracked file alone", async () => {
  const fixture = await makeFixture({ "product-plans/80/spec.md": "base\n" });
  write(fixture.clone, "product-plans/80/spec.md", "local\n");
  commitLocal(fixture, "local");
  write(fixture.other, "product-plans/80/spec.md", "remote\n");
  publishOther(fixture);
  expect(() => git(fixture.clone, "pull", "--rebase")).toThrow();
  write(fixture.clone, "unrelated.md", "leave alone\n");
  await resolveStoppedRebase({ stdout: makeSink(), stderr: makeSink() }, fixture.clone);
  expect(git(fixture.clone, "ls-files", "--others", "--exclude-standard")).toBe("unrelated.md");
  expect(git(fixture.clone, "ls-files", "--cached")).not.toContain("unrelated.md");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it("reports a live lock after three attempts within ten seconds", async () => {
  const fixture = await makeFixture();
  const path = join(fixture.clone, ".git/alignfirst-sync.lock");
  mkdirSync(path);
  writeFileSync(join(path, "pid"), String(process.pid));
  const started = Date.now();
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("lock is busy");
  expect(result.stderr).toContain(path);
  expect(result.stderr).toContain(String(process.pid));
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(path)).toBe(true);
}, 10_000);

it("replaces a stale lock and releases it after sync", async () => {
  const fixture = await makeFixture();
  const path = join(fixture.clone, ".git/alignfirst-sync.lock");
  mkdirSync(path);
  writeFileSync(join(path, "pid"), "2147483647");
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(path)).toBe(false);
});

it("retries after the remote advances just before the first push", async () => {
  const fixture = await makeFixture();
  write(fixture.clone, "local.md", "local\n");
  write(fixture.other, "remote.md", "remote\n");
  git(fixture.other, "add", "-A");
  git(fixture.other, "commit", "--quiet", "-m", "remote race");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(fixture.root, "bin");
  const marker = join(fixture.root, "pushed");
  mkdirSync(bin);
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase " $* " in *" push "*)\n  if [ ! -f '${marker}' ]; then\n    touch '${marker}'\n    '${realGit}' -C '${fixture.other}' push --quiet || exit $?\n  fi\nesac\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const result = await runMain(["sync"], { cwd: fixture.product });
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(marker)).toBe(true);
  expect(result.stderr).toContain("rejected");
  expect(remoteContent(fixture, "local.md")).toBe("local\n");
  expect(remoteContent(fixture, "remote.md")).toBe("remote\n");
  expect(git(fixture.remote, "log", "--format=%s")).toContain("remote race");
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

function commitLocal(fixture: Fixture, message: string): void {
  git(fixture.clone, "add", "-A");
  git(fixture.clone, "commit", "--quiet", "-m", message);
}

async function makeFixture(initial: Record<string, string> = {}): Promise<Fixture> {
  const root = makeTempDir("alignfirst-conflicts-");
  dirs.push(root);
  configureGit(root);
  const product = join(root, "product");
  const clone = join(root, "plans");
  const remote = join(root, "remote.git");
  const other = join(root, "other");
  git(root, "init", "--bare", "--quiet", remote);
  git(root, "clone", "--quiet", remote, clone);
  write(clone, "README.md", "Plans\n");
  write(clone, "product-plans/.gitkeep", "");
  for (const [path, content] of Object.entries(initial)) write(clone, path, content);
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "base");
  git(clone, "push", "--quiet", "-u", "origin", "HEAD");
  git(root, "clone", "--quiet", remote, other);
  git(root, "init", "--quiet", product);
  const setup = await runMain(["plans", "setup", clone, "--folder", "product-plans"], {
    cwd: product,
  });
  expect(setup.code, setup.stderr).toBe(0);
  return { root, product, clone, other, remote };
}

function write(repo: string, path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function publishOther(fixture: Fixture): void {
  git(fixture.other, "add", "-A");
  git(fixture.other, "commit", "--quiet", "-m", "remote");
  git(fixture.other, "push", "--quiet");
}

function remoteContent(fixture: Fixture, path: string): string {
  return execFileSync("git", ["-C", fixture.remote, "show", `HEAD:${path}`], { encoding: "utf8" });
}
