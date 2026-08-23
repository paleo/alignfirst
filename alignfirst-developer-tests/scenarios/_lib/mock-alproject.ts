import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ScenarioContext } from "@paleo/openclaw-test";
import {
  EXTERNAL_PROJECT_PARENT,
  LUMEN_PROJECT_PATH,
  NIMBUS_PROJECT_PATH,
  ORION_PROJECT_PATH,
  PRIMARY_PROJECT_PARENT,
} from "./project-fixtures.ts";

const DEFAULT_PROJECTS: AlprojectRecord[] = [
  registeredProject("orion", ORION_PROJECT_PATH, EXTERNAL_PROJECT_PARENT),
  registeredProject("lumen", LUMEN_PROJECT_PATH, PRIMARY_PROJECT_PARENT),
  registeredProject("nimbus", NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT),
];

export interface AlprojectRecord {
  name: string;
  mainPath: string;
  parent: string;
  status?: "registered" | "unregistered" | "missing";
  workspaces?: string[];
  basePort?: number;
  endPort?: number;
  maxWorkspaces?: number;
  portsPerWorkspace?: number;
}

export interface AdditionalDirectoryGroup {
  parent: string;
  directories: string[];
}

export interface AlprojectMockCall {
  argv: string[];
  cwd: string;
  order: number;
}

export interface AlprojectMockHandle {
  calls: AlprojectMockCall[];
  projects: AlprojectRecord[];
  assertListCallCount(expected: number): void;
}

export interface AlprojectCommandResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface SetupAlprojectMockOptions {
  projects?: AlprojectRecord[];
  additionalDirectories?: AdditionalDirectoryGroup[];
  guide?: string;
  guideResponse?: AlprojectCommandResponse;
  registerResponse?: AlprojectCommandResponse;
  unregisterResponse?: AlprojectCommandResponse;
  registerBasePort?: number;
}

export function setupAlprojectMock(
  ctx: ScenarioContext,
  options: SetupAlprojectMockOptions = {},
): AlprojectMockHandle {
  const calls: AlprojectMockCall[] = [];
  const projects = (options.projects ?? DEFAULT_PROJECTS).map((project) => ({ ...project }));
  const additionalDirectories = options.additionalDirectories ?? [];

  ctx.mockCli("alproject", async ({ argv, cwd, stdout, stderr }) => {
    calls.push({ argv: [...argv], cwd, order: calls.length + 1 });
    if (argv.length === 2 && argv[0] === "list" && argv[1] === "--json") {
      stdout.write(renderAlprojectJson(projects, additionalDirectories));
      return 0;
    }
    if (argv.length === 1 && argv[0] === "list") {
      stdout.write(renderAlprojectList(projects, additionalDirectories));
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--guide") {
      return writeResponse(
        options.guideResponse ?? { stdout: options.guide ?? defaultLifecycleGuide() },
        stdout,
        stderr,
      );
    }
    // Read-only modes the real CLI serves; rejecting them would fail a scenario
    // over a harmless orienting call (A17 Discord ran `--help` before `--guide`).
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      stdout.write(helpText());
      return 0;
    }
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
      stdout.write("0.1.0\n");
      return 0;
    }
    if (argv[0] === "register" && argv[1] !== undefined) {
      return registerProject(argv, projects, options, stdout, stderr);
    }
    if (argv.length === 2 && argv[0] === "unregister") {
      return unregisterProject(argv[1], projects, options, stdout, stderr);
    }
    throw new Error(`unexpected alproject invocation: ${JSON.stringify(argv)}`);
  });

  return {
    calls,
    projects,
    assertListCallCount(expected) {
      const listCalls = calls.filter((call) => call.argv[0] === "list");
      if (listCalls.length !== expected) {
        throw new Error(
          `expected ${expected} alproject list call(s), got ${listCalls.length}: ${JSON.stringify(calls)}`,
        );
      }
      for (const [index, call] of calls.entries()) {
        if (call.order !== index + 1) throw new Error("alproject call order is inconsistent");
      }
    },
  };
}

function registerProject(
  argv: string[],
  projects: AlprojectRecord[],
  options: SetupAlprojectMockOptions,
  stdout: { write(chunk: string): void },
  stderr: { write(chunk: string): void },
): number {
  const path = argv[1];
  // The real CLI rejects a global mode or option where <path> belongs
  // ("invalid combinations print a concise error and exit non-zero").
  if (path?.startsWith("-")) {
    stderr.write(
      "alproject: register requires <path> first. " +
        "Usage: alproject register <path> [--ports-per-workspace <n> --max-workspaces <n>]\n",
    );
    return 1;
  }
  if (!existsSync(`${path}/.git`)) {
    stderr.write(`mock-alproject: register before .git exists: ${path}\n`);
    return 1;
  }
  const response = options.registerResponse;
  if ((response?.exitCode ?? 0) !== 0) return writeResponse(response ?? {}, stdout, stderr);
  const portsPerWorkspace = numericOption(argv, "--ports-per-workspace");
  const maxWorkspaces = numericOption(argv, "--max-workspaces");
  const basePort = portsPerWorkspace === undefined ? undefined : (options.registerBasePort ?? 6600);
  const reservedPorts = (portsPerWorkspace ?? 1) * (maxWorkspaces ?? 1);
  projects.push({
    name: basename(path),
    mainPath: path,
    parent: dirname(path),
    status: "registered",
    ...(basePort === undefined
      ? {}
      : {
          basePort,
          endPort: basePort + reservedPorts - 1,
          maxWorkspaces,
          portsPerWorkspace,
        }),
  });
  const defaultOutput =
    basePort === undefined
      ? `Registered project: ${JSON.stringify(path)}\n`
      : `Registered project: ${JSON.stringify(path)}\nBase port: ${basePort}\n` +
        `Port range: ${basePort}..${basePort + reservedPorts - 1}\n`;
  return writeResponse({ stdout: response?.stdout ?? defaultOutput }, stdout, stderr);
}

function unregisterProject(
  path: string,
  projects: AlprojectRecord[],
  options: SetupAlprojectMockOptions,
  stdout: { write(chunk: string): void },
  stderr: { write(chunk: string): void },
): number {
  const response = options.unregisterResponse;
  if ((response?.exitCode ?? 0) !== 0) return writeResponse(response ?? {}, stdout, stderr);
  const index = projects.findIndex((project) => project.mainPath === path);
  if (index === -1) {
    stderr.write(`mock-alproject: unknown project: ${path}\n`);
    return 1;
  }
  projects.splice(index, 1);
  return writeResponse(
    { stdout: response?.stdout ?? `Unregistered project: ${JSON.stringify(path)}\n` },
    stdout,
    stderr,
  );
}

function writeResponse(
  response: AlprojectCommandResponse,
  stdout: { write(chunk: string): void },
  stderr: { write(chunk: string): void },
): number {
  if (response.stdout !== undefined) stdout.write(response.stdout);
  if (response.stderr !== undefined) stderr.write(response.stderr);
  return response.exitCode ?? 0;
}

function numericOption(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || argv[index + 1] === undefined) return;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) ? value : undefined;
}

function helpText(): string {
  return `alproject — project registry and port allocator

Commands:
  alproject list [--json]
  alproject register <path> [--ports-per-workspace <n> --max-workspaces <n>]
  alproject unregister <path>

Modes: --guide (complete procedures), --help, -v/--version
`;
}

function defaultLifecycleGuide(): string {
  return `# alproject guide

Allowed project parents:

- /home/claw/projects
- /home/claw/external-projects
- /home/claw/lifecycle-projects

Create Node projects with npm. Keep bootstrap work in the main worktree through the initial commit.
Use the project's documented workspace command for linked-worktree removal.
`;
}

export function registeredProject(name: string, mainPath: string, parent: string): AlprojectRecord {
  return { name, mainPath, parent, status: "registered" };
}

function renderAlprojectList(
  projects: AlprojectRecord[],
  additionalDirectories: AdditionalDirectoryGroup[],
): string {
  const lines = ["Projects:"];
  if (projects.length === 0) lines.push("  (none)");
  for (const project of projects) {
    lines.push(
      `- Name: ${JSON.stringify(project.name)}`,
      `  Main path: ${JSON.stringify(project.mainPath)}`,
      `  Parent: ${JSON.stringify(project.parent)}`,
      `  Status: ${statusLabel(project.status ?? "registered")}`,
      `  Workspaces: ${
        project.workspaces === undefined || project.workspaces.length === 0
          ? "(none)"
          : project.workspaces.map((workspace) => JSON.stringify(workspace)).join(", ")
      }`,
    );
    if (project.basePort !== undefined) lines.push(`  Base port: ${project.basePort}`);
    if (project.endPort !== undefined)
      lines.push(`  Port range: ${project.basePort}..${project.endPort}`);
  }
  lines.push("", "Additional directories:");
  if (additionalDirectories.length === 0) lines.push("  (none)");
  for (const group of additionalDirectories) {
    lines.push(`- Parent: ${JSON.stringify(group.parent)}`);
    for (const directory of group.directories) lines.push(`  - ${JSON.stringify(directory)}`);
  }
  return `${lines.join("\n")}\n`;
}

function statusLabel(status: NonNullable<AlprojectRecord["status"]>): string {
  if (status === "missing") return "registered but missing from filesystem";
  if (status === "unregistered") return "unregistered on filesystem";
  return "registered";
}

function renderAlprojectJson(
  projects: AlprojectRecord[],
  additionalDirectories: AdditionalDirectoryGroup[],
): string {
  return `${JSON.stringify(
    {
      projects: projects.map((project) => ({
        name: project.name,
        parent: project.parent,
        path: project.mainPath,
        status: project.status ?? "registered",
        workspaces: project.workspaces ?? [],
        ...(project.basePort === undefined
          ? {}
          : {
              ports: {
                basePort: project.basePort,
                endPort: project.endPort,
                maxWorkspaces: project.maxWorkspaces,
                portsPerWorkspace: project.portsPerWorkspace,
              },
            }),
      })),
      additionalDirectories,
    },
    undefined,
    2,
  )}\n`;
}
