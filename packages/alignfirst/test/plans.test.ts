import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plans commands", () => {
  it("reports local plans mode", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = await runMain(["plans", "check"], { cwd: fixture.product });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("local plans mode");
  });

  it("sets up the plans link with the configured folder", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "product-plans" } }),
    );
    const result = await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product });
    expect(result.code).toBe(0);
    expect(lstatSync(join(fixture.product, ".plans")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(
      join("..", "team-plans", "product-plans"),
    );
    expect(result.stdout).toContain("Publish with: alignfirst sync");
  });

  it("synchronizes shared plans", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    mkdirSync(join(fixture.product, ".plans", "78"));
    writeFileSync(join(fixture.product, ".plans", "78", "A1-spec.md"), "spec\n");
    const result = await runMain(["sync"], { cwd: fixture.product });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local changes sent");
    expect(git(join(fixture.root, "remote.git"), "ls-tree", "-r", "HEAD", "--name-only")).toContain(
      "product-plans/78/A1-spec.md",
    );
  });

  it("rejects conflicting, absent and missing-clone setup inputs", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "configured" } }),
    );
    expect(
      (
        await runMain(["plans", "setup", fixture.clone, "--folder", "argument"], {
          cwd: fixture.product,
        })
      ).stderr,
    ).toContain("already sets plans.folder");
    rmSync(join(fixture.product, ".alignfirst.json"));
    expect(
      (await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product })).stderr,
    ).toContain("Pass --folder");
    expect(
      (
        await runMain(["plans", "setup", join(fixture.root, "missing"), "--folder", "p"], {
          cwd: fixture.product,
        })
      ).stderr,
    ).toContain("does not exist");
  });

  it("archives a ticket and honors ALIGNFIRST_ARCHIVE_DAYS", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans", "78"), { recursive: true });
    const archive = await runMain(["plans", "archive", "78"], { cwd: fixture.product });
    expect(archive.code).toBe(0);
    expect(existsSync(join(fixture.product, ".plans", "_archives", "78"))).toBe(true);
    const stale = join(fixture.product, ".plans", "79");
    mkdirSync(stale);
    const date = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, date, date);
    const automatic = await runMain(["plans", "auto-archive"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });
    expect(automatic.stdout).toContain("Archived 79");
  });
});

interface Fixture {
  root: string;
  product: string;
  clone: string;
}

function makeFixture(): Fixture {
  const root = makeTempDir("alignfirst-plans-");
  dirs.push(root);
  configureGit(root);
  const remote = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", remote);
  const clone = join(root, "team-plans");
  git(root, "clone", "--quiet", remote, clone);
  const product = join(root, "product");
  git(root, "init", "--quiet", product);
  writeFileSync(join(product, "README.md"), "product\n");
  git(product, "add", "-A");
  git(product, "commit", "--quiet", "-m", "init");
  return { root, product, clone };
}
