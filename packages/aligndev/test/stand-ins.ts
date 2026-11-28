import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ItemLocation, ItemName, ItemSetting, ProjectReport } from "../src/project/layout.js";

const ITEM_FILES: Record<ItemName, string> = {
  alignfirst: "alignfirst.json",
  ".alignfirst-instructions": ".alignfirst-instructions",
  assistantInstructionsFile: "ASSISTANTS.md",
  workspaceRuntime: ".local-wt",
  docs: "docs",
  ".plans": ".plans",
  _aligndev: ".plans",
};
const EXISTS_MARK = "@@exists@@";

export interface ReportOptions {
  companion?: { dir: string; items: Partial<Record<ItemName, "project" | "companion">> };
  aligndev?: { profile: string };
}

// An `alignfirst config --json` report for a project without `alignfirst.json`. `_aligndev` follows
// `.plans` unless the companion items place it.
export function buildReport(project: string, options: ReportOptions = {}): ProjectReport {
  const { companion } = options;
  const placement = (item: ItemName) =>
    companion?.items[item] ?? (item === "_aligndev" ? companion?.items[".plans"] : undefined);
  const location = (item: ItemName): ItemLocation => {
    const inCompanion = companion !== undefined && placement(item) === "companion";
    const dir = inCompanion ? companion.dir : project;
    return {
      path: join(dir, ITEM_FILES[item]),
      in: inCompanion ? "companion" : "project",
      exists: false,
    };
  };
  return {
    source: null,
    workspace: {
      location: location("alignfirst"),
      registryDir: join(project, ".local-wt", "workspace-registry"),
      runtimeDir: join(project, ".local-wt"),
      schemaVersion: null,
      portRange: null,
      hasDevServer: false,
    },
    config: null,
    companion:
      companion === undefined
        ? null
        : {
            dir: companion.dir,
            exists: false,
            defaultLocation: "auto",
            items: itemRecord((item): ItemSetting => companion.items[item] ?? "auto"),
          },
    aligndev: options.aligndev ?? null,
    locations: itemRecord(location),
    selectionOrigins: itemRecord((item) =>
      companion?.items[item] === undefined ? "builtin" : "item",
    ),
  };
}

function itemRecord<T>(value: (item: ItemName) => T): Record<ItemName, T> {
  return {
    alignfirst: value("alignfirst"),
    ".alignfirst-instructions": value(".alignfirst-instructions"),
    assistantInstructionsFile: value("assistantInstructionsFile"),
    workspaceRuntime: value("workspaceRuntime"),
    docs: value("docs"),
    ".plans": value(".plans"),
    _aligndev: value("_aligndev"),
  };
}

export interface StubOptions extends ReportOptions {
  sideTicket?: string;
  catchup?: { stderr?: string; status?: number };
}

export interface AlignfirstStub {
  command: string[];
  // The argument lines of every call, oldest first.
  invocations(): string[];
}

// Writes `<dir>/alignfirst`, a POSIX shell stand-in that answers the calls aligndev makes for
// `project`. The report's `exists` fields are probed at each call. It uses shell built-ins only, so
// it runs under a test-restricted PATH.
export function writeAlignfirstStub(
  dir: string,
  project: string,
  options: StubOptions = {},
): AlignfirstStub {
  const executable = join(dir, "alignfirst");
  const log = join(dir, "alignfirst.log");
  const report = buildReport(project, options);
  const plans = report.locations[".plans"].path;
  const catchup = options.catchup ?? {};
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
e() { if [ -e "$1" ]; then printf true; else printf false; fi; }
case "$*" in
  "config --json") printf '%s\\n' ${renderReport(report)} ;;
  "plans check --json")
    if [ ! -d ${quote(plans)} ]; then echo "No .plans/ directory." >&2; exit 1; fi
    printf '%s\\n' ${quote(JSON.stringify({ plans: { target: plans } }))} ;;
  "ticket --side --json")
    printf '%s\\n' ${quote(JSON.stringify({ TICKET_ID: options.sideTicket ?? "side-1" }))} ;;
  context) printf '%s\\n' "alignfirst context output" ;;
  *)
    if [ $# -eq 3 ] && [ "$1" = ticket ] && [ "$3" = --json ]; then
      printf '{"TICKET_ID":"%s"}\\n' "$2"
    elif [ $# -eq 3 ] && [ "$1" = ticket ] && [ "$3" = --catchup ]; then
      printf '%s' ${quote(catchup.stderr ?? "")} >&2
      printf 'Catch-up of ticket %s' "$2"
      exit ${catchup.status ?? 0}
    else
      echo "alignfirst stub: unexpected arguments: $*" >&2
      exit 2
    fi ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    command: [executable],
    invocations: () => {
      try {
        return readFileSync(log, "utf8").split("\n").slice(0, -1);
      } catch {
        return [];
      }
    },
  };
}

// The report as shell words; each location's `exists` becomes a probe of its path.
function renderReport(report: ProjectReport): string {
  const probe = (path: string) => `${EXISTS_MARK}${path}${EXISTS_MARK}`;
  const probed = {
    ...report,
    companion: report.companion && { ...report.companion, exists: probe(report.companion.dir) },
    locations: itemRecord((item) => {
      const location = report.locations[item];
      return { ...location, exists: probe(location.path) };
    }),
  };
  const pattern = new RegExp(`"${EXISTS_MARK}(.*?)${EXISTS_MARK}"`, "g");
  return quote(JSON.stringify(probed)).replace(pattern, (_, path) => `'"$(e ${quote(path)})"'`);
}

export interface FakeAgent {
  // PATH with the fake first.
  path: string;
  received(): { prompt: string; args: string[] };
}

// Writes `<base>/bin/<name>`, a POSIX shell fake agent that records its stdin prompt and its
// arguments, one per line, then runs the shell `body`.
export function installFakeAgent(base: string, name: string, body: string): FakeAgent {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const promptFile = join(bin, `${name}-prompt.txt`);
  const argsFile = join(bin, `${name}-args.txt`);
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
cat > ${quote(promptFile)}
for arg in "$@"; do printf '%s\\n' "$arg"; done > ${quote(argsFile)}
${body}
`,
    { mode: 0o755 },
  );
  return {
    path: `${bin}:${process.env.PATH ?? ""}`,
    received: () => ({
      prompt: readFileSync(promptFile, "utf8"),
      args: readFileSync(argsFile, "utf8").split("\n").slice(0, -1),
    }),
  };
}

// Shell lines printing each value as one JSON line on stdout.
export function printJsonLines(...values: object[]): string {
  return values.map((value) => `printf '%s\\n' ${quote(JSON.stringify(value))}`).join("\n");
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
