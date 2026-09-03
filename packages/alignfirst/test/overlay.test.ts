import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findOverlay,
  normalizeRemoteUrl,
  resolveProjectConfig,
  resolveProjectFile,
} from "../src/overlay.js";
import { git, makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("overlays", () => {
  it("normalizes scp and URL remotes", () => {
    expect(normalizeRemoteUrl("git@GitHub.COM:Org/Repo.git")).toBe("github.com/Org/Repo");
    expect(normalizeRemoteUrl("https://user@GitHub.COM:8443/Org/Repo.git/")).toBe(
      "github.com/Org/Repo",
    );
  });

  it("matches remote before paths", () => {
    const fixture = makeFixture();
    writeOverlay(fixture.overlays, "by-path", {
      schemaVersion: 1,
      project: { paths: [realpathSync(fixture.project)] },
    });
    const remoteDir = writeOverlay(fixture.overlays, "by-remote", {
      schemaVersion: 1,
      project: { remote: "github.com/Org/Repo" },
    });
    expect(
      findOverlay(fixture.project, { ALIGNFIRST_OVERLAYS: fixture.overlays }, fixture.home),
    ).toMatchObject({ dir: remoteDir, matchedBy: "remote" });
  });

  it("matches paths, expands ~/ and rejects ambiguity", () => {
    const fixture = makeFixture();
    const config = {
      schemaVersion: 1 as const,
      project: { paths: [realpathSync(fixture.project)] },
    };
    writeOverlay(fixture.overlays, "one", config);
    expect(
      findOverlay(fixture.project, { ALIGNFIRST_OVERLAYS: "~/overlays" }, fixture.home),
    ).toMatchObject({
      matchedBy: "paths",
    });
    writeOverlay(fixture.overlays, "two", config);
    expect(() =>
      findOverlay(fixture.project, { ALIGNFIRST_OVERLAYS: fixture.overlays }, fixture.home),
    ).toThrow("Multiple AlignFirst overlays");
  });

  it("resolves root files before overlay files and carries a matched overlay with root config", () => {
    const fixture = makeFixture();
    const overlayDir = writeOverlay(fixture.overlays, "project", {
      schemaVersion: 1,
      project: { paths: [realpathSync(fixture.project)] },
    });
    mkdirSync(join(overlayDir, "docs"));
    writeFileSync(join(overlayDir, "DEVELOPERS.md"), "overlay");
    const overlay = findOverlay(
      fixture.project,
      { ALIGNFIRST_OVERLAYS: fixture.overlays },
      fixture.home,
    );
    expect(resolveProjectFile(fixture.project, overlay, "docs")).toEqual({
      path: join(overlayDir, "docs"),
      source: "overlay",
    });
    writeFileSync(join(fixture.project, "DEVELOPERS.md"), "root");
    expect(resolveProjectFile(fixture.project, overlay, "DEVELOPERS.md")).toEqual({
      path: join(fixture.project, "DEVELOPERS.md"),
      source: "root",
    });
    writeFileSync(join(fixture.project, ".alignfirst.json"), '{"schemaVersion":1}');
    expect(
      resolveProjectConfig(
        fixture.project,
        { ALIGNFIRST_OVERLAYS: fixture.overlays },
        fixture.home,
      ),
    ).toMatchObject({ source: "root", overlay: { dir: overlayDir } });
  });
});

interface Fixture {
  home: string;
  project: string;
  overlays: string;
}

function makeFixture(): Fixture {
  const home = makeTempDir("alignfirst-overlay-");
  dirs.push(home);
  const project = join(home, "project");
  const overlays = join(home, "overlays");
  mkdirSync(project);
  mkdirSync(overlays);
  git(project, "init", "--quiet");
  git(project, "remote", "add", "origin", "https://user@GitHub.COM:8443/Org/Repo.git");
  return { home, project, overlays };
}

function writeOverlay(overlays: string, name: string, config: object): string {
  const dir = join(overlays, name, "_project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".alignfirst.json"), JSON.stringify(config));
  return dir;
}
