import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { findStoppedRebase, resolveStoppedRebase } from "../src/plans/rebase.js";
import { git, makeSink, runMain } from "./helpers.js";
import {
  commitLocal,
  makeSyncFixture,
  publishOther,
  remoteContent,
  removeSyncFixtures,
  write,
} from "./plan-sync-fixture.js";

const UNUSUAL_NAMES = ["résumé.md", " leading.md", "line\nbreak.md", "[spec]*.md", "tab\tfile.md"];

afterEach(removeSyncFixtures);

it("preserves independently added documents with unusual names exactly, locally and remotely", async () => {
  const fixture = await makeSyncFixture();
  const dir = "product-plans/80";
  for (const [index, name] of UNUSUAL_NAMES.entries()) {
    write(fixture.clone, `${dir}/${name}`, `local ${index}\n\n`);
    write(fixture.other, `${dir}/${name}`, `remote ${index}\n\n`);
  }
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  const files = readdirSync(join(fixture.clone, dir));
  expect(files).toHaveLength(2 * UNUSUAL_NAMES.length);
  for (const [index, name] of UNUSUAL_NAMES.entries()) {
    expect(readFileSync(join(fixture.clone, dir, name), "utf8")).toBe(`remote ${index}\n\n`);
    expect(remoteContent(fixture, `${dir}/${name}`)).toBe(`remote ${index}\n\n`);
  }
  const copies = files.filter((file) => !UNUSUAL_NAMES.includes(file));
  const locals = UNUSUAL_NAMES.map((_, index) => `local ${index}\n\n`);
  expect(copies.map((copy) => readFileSync(join(fixture.clone, dir, copy), "utf8")).sort()).toEqual(
    locals,
  );
  expect(copies.map((copy) => remoteContent(fixture, `${dir}/${copy}`)).sort()).toEqual(locals);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
});

it("preserves both original destinations of a real rename/rename conflict", async () => {
  const common = Array.from({ length: 30 }, (_, index) => `shared line ${index}\n`).join("");
  const fixture = await makeSyncFixture({ "product-plans/80/original.md": `${common}base\n` });
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
    const fixture = await makeSyncFixture({ [path]: "base\n" });
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
  const fixture = await makeSyncFixture();
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
  const fixture = await makeSyncFixture({ [path]: `start\n${middle}end\n` });
  write(fixture.clone, path, `local start\n${middle}end\n`);
  write(fixture.other, path, `start\n${middle}remote end\n`);
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, path)).toBe(`local start\n${middle}remote end\n`);
  expect(readdirSync(join(fixture.clone, dirname(path)))).toEqual([basename(path)]);
});

it("does not restore an unrelated document deleted upstream while rewriting references", async () => {
  const fixture = await makeSyncFixture({ "product-plans/80/obsolete.md": "obsolete\n" });
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
  const fixture = await makeSyncFixture();
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
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
  expect(remoteContent(fixture, path)).toBe(`remote\n${middle}old tail\n`);
  expect(readdirSync(join(fixture.clone, "product-plans/80"))).toEqual(["spec.md"]);
});

it("allocates a free local name without overwriting an existing copy", async () => {
  const fixture = await makeSyncFixture({ "product-plans/80/spec-local-2.md": "existing copy\n" });
  write(fixture.clone, "product-plans/80/spec.md", "local\n");
  write(fixture.other, "product-plans/80/spec.md", "remote\n");
  publishOther(fixture);

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteContent(fixture, "product-plans/80/spec-local-2.md")).toBe("existing copy\n");
  expect(remoteContent(fixture, "product-plans/80/spec-local-3.md")).toBe("local\n");
});

it("stops when a later local document would refer to the wrong version", async () => {
  const fixture = await makeSyncFixture();
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
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
});

it("updates references in an earlier local document when its spec is renamed", async () => {
  const fixture = await makeSyncFixture();
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
  const fixture = await makeSyncFixture();
  write(fixture.clone, "product-plans/80/spec.md", "local file\n");
  commitLocal(fixture, "local file");
  const localBefore = git(fixture.clone, "rev-parse", "HEAD");
  write(fixture.other, "product-plans/80/spec.md/child.md", "remote child\n");
  publishOther(fixture);
  const before = git(fixture.remote, "rev-parse", "HEAD");

  const result = await runMain(["sync"], { cwd: fixture.product });

  expect(result.code).toBe(1);
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(localBefore);
  expect(readFileSync(join(fixture.clone, "product-plans/80/spec.md"), "utf8")).toBe(
    "local file\n",
  );
});

it("aborts the rebase when a conflicted filename cannot be decoded losslessly", async () => {
  const fixture = await makeSyncFixture();
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
  expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  expect(git(fixture.remote, "rev-parse", "HEAD")).toBe(before);
});

it("stages only resolver paths and leaves an unrelated untracked file alone", async () => {
  const fixture = await makeSyncFixture({ "product-plans/80/spec.md": "base\n" });
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
