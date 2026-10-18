import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent discovery", () => {
  it("provides a generic bundled worker without creating a user directory", () => {
    const dir = temporary();
    const worker = discoverAgents({
      cwd: dir,
      agentDir: join(dir, "absent"),
      scope: "user",
      trusted: false,
    })("worker");
    expect(worker).toMatchObject({
      name: "worker",
      source: "bundled",
      tools: ["read", "bash", "edit", "write"],
    });
    expect(worker.prompt).not.toMatch(/alignfirst|aligndev/i);
  });

  it("resolves user then explicitly trusted project overrides deterministically", () => {
    const dir = temporary();
    profile(join(dir, "user", "agents"), "worker", "tools: read, bash\nmodel: provider/profile");
    profile(join(dir, "project", ".pi", "agents"), "worker", "tools: [read]");
    const options = { cwd: join(dir, "project"), agentDir: join(dir, "user"), trusted: true };
    expect(discoverAgents({ ...options, scope: "user" })("worker")).toMatchObject({
      source: "user",
      model: "provider/profile",
      tools: ["read", "bash"],
    });
    expect(discoverAgents({ ...options, scope: "both" })("worker")).toMatchObject({
      source: "project",
      tools: ["read"],
    });
    expect(discoverAgents({ ...options, scope: "project" })("worker")).toMatchObject({
      source: "project",
    });
  });

  it.each(["project", "both"] as const)("refuses untrusted %s scope without UI bypass", (scope) => {
    expect(() => discoverAgents({ cwd: temporary(), scope, trusted: false })).toThrow("/trust");
  });

  it.each([
    "tools: 42",
    "tools: [read, 4]",
    "tools: []",
    "tools: {read: true}",
    "tools: 'read,,bash'",
    "model: 42",
  ])("rejects requested malformed restrictions: %s", (frontmatter) => {
    const dir = temporary();
    profile(join(dir, "agents"), "bad", frontmatter);
    const discover = discoverAgents({ cwd: dir, agentDir: dir, scope: "user", trusted: false });
    expect(discover("worker").source).toBe("bundled");
    expect(() => discover("bad")).toThrow("Invalid agent bad");
  });

  it("rejects unknown names and duplicate names within one source", () => {
    const dir = temporary();
    profile(join(dir, "agents"), "duplicate", "tools: read");
    writeFileSync(
      join(dir, "agents", "other.md"),
      "---\nname: duplicate\ndescription: duplicate\n---\nprompt",
    );
    const discover = discoverAgents({ cwd: dir, agentDir: dir, scope: "user", trusted: false });
    expect(() => discover("missing")).toThrow("Available:");
    expect(() => discover("duplicate")).toThrow("Duplicate profile");
  });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-agents-"));
  directories.push(directory);
  return directory;
}

function profile(directory: string, name: string, frontmatter: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.md`),
    `---\nname: ${name}\ndescription: fixture\n${frontmatter}\n---\nGeneric profile prompt.`,
  );
}
