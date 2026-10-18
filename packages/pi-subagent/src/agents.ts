import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const WORKER: AgentProfile = {
  name: "worker",
  source: "bundled",
  tools: ["read", "bash", "edit", "write"],
  prompt:
    "Follow the delegated assignment and project instructions. Report results, checks, and " +
    "blockers concisely. Ask the parent for missing requirements rather than inventing them. " +
    "Do not launch detached work, daemons, or commands intended to outlive this assignment.",
};

export interface AgentProfile {
  name: string;
  source: "bundled" | "user" | "project";
  tools?: string[];
  model?: string;
  prompt: string;
}

export interface DiscoveryOptions {
  cwd: string;
  scope: "user" | "project" | "both";
  trusted: boolean;
  agentDir?: string;
}

interface ProfileEntry {
  profile?: AgentProfile;
  error?: string;
}

export function discoverAgents(options: DiscoveryOptions): (name: string) => AgentProfile {
  if (options.scope !== "user" && !options.trusted) {
    throw new Error(
      "Project agent scope requires a trusted parent project. Review it and use Pi /trust first.",
    );
  }
  const profiles = new Map<string, ProfileEntry>([["worker", { profile: WORKER }]]);
  if (options.scope !== "project") {
    loadDirectory(join(options.agentDir ?? getAgentDir(), "agents"), "user", profiles);
  }
  if (options.scope !== "user") {
    const project = findProjectDirectory(options.cwd);
    if (project !== undefined) loadDirectory(project, "project", profiles);
  }
  return (name) => {
    const entry = profiles.get(name);
    if (entry?.error !== undefined) throw new Error(entry.error);
    if (!entry?.profile) {
      throw new Error(
        `Unknown agent ${JSON.stringify(name)}. Available: ${[...profiles.keys()].sort().join(", ")}`,
      );
    }
    return { ...entry.profile, tools: entry.profile.tools?.slice() };
  };
}

function loadDirectory(
  dir: string,
  source: "user" | "project",
  profiles: Map<string, ProfileEntry>,
): void {
  if (!existsSync(dir)) return;
  const seen = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const path = join(dir, entry.name);
    let name = entry.name.slice(0, -3);
    try {
      if (statSync(path).size > 64 * 1024) throw new Error("Profile exceeds 64 KiB.");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
        readFileSync(path, "utf8"),
      );
      if (typeof frontmatter.name === "string" && frontmatter.name.trim() !== "")
        name = frontmatter.name;
      if (seen.has(name)) throw new Error(`Duplicate profile name ${name}.`);
      if (
        typeof frontmatter.name !== "string" ||
        frontmatter.name.trim() === "" ||
        typeof frontmatter.description !== "string" ||
        frontmatter.description.trim() === ""
      ) {
        throw new Error("Frontmatter requires nonblank name and description strings.");
      }
      const tools = parseTools(frontmatter.tools);
      if (
        frontmatter.model !== undefined &&
        (typeof frontmatter.model !== "string" || frontmatter.model.trim() === "")
      ) {
        throw new Error("model must be a nonblank string.");
      }
      profiles.set(name, {
        profile: {
          name,
          source,
          tools,
          prompt: body,
          model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        },
      });
    } catch (error) {
      profiles.set(name, {
        error: `Invalid agent ${name} (${path}): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    seen.add(name);
  }
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return;
  const tools: unknown[] =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  if (
    tools.length === 0 ||
    tools.some((tool) => typeof tool !== "string" || !/^[a-zA-Z_][\w.*-]*$/.test(tool.trim()))
  ) {
    throw new Error(
      "tools must be a nonempty list or comma-separated string of tool names/patterns.",
    );
  }
  return tools.map((tool) => String(tool).trim());
}

function findProjectDirectory(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".pi", "agents");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
