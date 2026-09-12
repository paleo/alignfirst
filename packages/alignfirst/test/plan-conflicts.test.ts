import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { findStoppedRebase } from "../src/plans/rebase.js";
import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

interface Fixture {
  root: string;
  product: string;
  clone: string;
  other: string;
  remote: string;
}

afterEach(() => {
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
  write(fixture.other, path, `remote\n${middle}old tail\n`);
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("a later local commit edits it");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeDefined();
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
  write(fixture.other, "product-plans/80/spec.md", "remote spec\n");
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("later local commit references a renamed document");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeDefined();
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
  write(fixture.other, "product-plans/80/spec.md/child.md", "remote child\n");
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Resolve the rebase manually");
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeDefined();
  expect(existsSync(join(fixture.clone, "product-plans/80/spec.md/child.md"))).toBe(true);
});

it("stops before staging a filename that cannot be decoded losslessly", async () => {
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
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
});

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
