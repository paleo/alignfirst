import type { DevPortsConfig, PortRange } from "./ports.js";

/** Declarative workspace lifecycle and optional dev stack, independent of host project metadata. */
export interface WorkspaceManifest {
  /** Workspace preparation and teardown recipe. Omit for the default, hook-free preparation. */
  workspace?: WorkspaceSettings;
  /** Dev-stack recipe. Omit for a portless workspace with no dev-server lifecycle. */
  devServer?: DevSettings;
}

/** Preparation and destructive cleanup hooks shared by the main and linked worktrees. */
export interface WorkspaceSettings {
  /** Additional worktree-relative shares from main, beyond mandatory plans and default `.local`. */
  sharedDirs?: string[];
  /** Files needed for install/build/test, seeded during workspace setup; exclude port-bearing files. */
  gitignoredFiles?: FileEntry[];
  /** Ordered, idempotent hooks before file seeding; linked setup must not mutate the main worktree. */
  preSetup?: Step[];
  /** Ordered, idempotent install/build hooks after file seeding, run in the setup child. */
  finalize?: Step[];
  /**
   * Ordered destructive teardown after dev stop, including orphan cleanup. Hooks must tolerate
   * partial infrastructure and an absent target worktree. Omit when no external resources need purge.
   */
  purge?: PurgeStep[];
  /**
   * Workspace/status output. Setup evaluates it before finalization, so commands must tolerate
   * absent finalize outputs. Omission prints identity and current preparation status.
   */
  summary?: TextOutput;
}

/** A worktree-relative file seeded during workspace setup or dev setup, according to its section. */
export interface FileEntry {
  /** Destination relative to the target worktree root; must not overlap another seeded destination. */
  path: string;
  /** Initial content for a missing destination; existing files follow the setup overwrite policy. */
  source:
    | /** Copy the entry's destination path from the main worktree. */ {
        /** Selects the main-worktree copy strategy. */
        kind: "mainWorktree";
        /** Template relative to the target worktree, used only if the main-worktree file is absent. */
        fallback?: string;
      }
    | /** Copy a template from the target worktree's checkout so it follows that branch. */ {
        /** Selects a checked-out template rather than the main-worktree copy. */
        kind: "committed";
        /** Template path relative to the target worktree root. */
        path: string;
      }
    | /** Generate content without reading a source file. */ {
        /** Selects literal or command-produced content. */
        kind: "content";
        /** Initial text, evaluated in the workspace-file or run-file content phase. */
        content: TextOutput;
      };
  /**
   * Idempotent rewrite applied to seeded or existing content. Preserve unrelated lines; setup
   * rejects non-idempotent patches. Omit to keep the content unchanged.
   */
  patch?:
    | /** Update dotenv assignments while preserving unrelated entries. */ {
        /** Assignment values support phase-available `${{ ... }}` references. */
        env: Record<string, string>;
      }
    | /** Transform the current content through a subprocess. */ {
        /** Receives the content on stdin and returns its replacement on stdout. */
        command: Command;
      };
  /** Warn and skip a missing file source instead of failing; defaults to false, ignored for content. */
  optional?: boolean;
}

/** Phase-dependent text used by file content and summaries. */
export type TextOutput =
  | /** Literal text with phase-available `${{ ... }}` references interpolated. */ string
  | /** Produce text lazily when the lifecycle phase needs it. */ {
      /** Captured stdout becomes the text; a nonzero exit fails the phase. */
      command: Command;
    };

/**
 * A subprocess in a lifecycle phase. It inherits the invocation environment and receives
 * `ALIGNFIRST_WORKSPACE_CONTEXT` plus phase-available `ALIGNFIRST_*` convenience variables.
 */
export interface Command {
  /** Shell script or argument vector; only the vector form performs AlignFirst interpolation. */
  run:
    | /** Passed verbatim to `/bin/sh -c`; use shell environment expansion for context values. */ string
    | /** Executable followed by arguments, each interpolated without shell evaluation. */ string[];
  /**
   * Working directory, interpolated and resolved against the target worktree; defaults to `.`.
   * Purge uses the main worktree as its base when the target directory is absent.
   */
  cwd?: string;
  /**
   * Interpolated overrides of inherited variables. Names must be valid environment identifiers;
   * reserved AlignFirst context variables cannot be overridden.
   */
  env?: Record<string, string>;
}

/** A named command in an ordered lifecycle hook list, with the same execution contract as Command. */
export interface Step extends Command {
  /** Progress label and diagnostic identifier for this hook. */
  name: string;
}

/** A teardown step that may allow subsequent purge hooks to run after its failure. */
export interface PurgeStep extends Step {
  /**
   * Continue with later purge steps after failure; defaults to false. Failures still make purge
   * fail and retain recovery evidence. Cancellation always stops the sequence.
   */
  continueOnError?: boolean;
}

/** Dev setup, service startup/stop and summary settings for one workspace's stack. */
export interface DevSettings {
  /** Port allocation range and declarations. Omit when the stack needs no allocated ports. */
  ports?: DevPortsConfig;
  /** Port-bearing or runtime-only files written by dev setup rather than workspace setup. */
  runFiles?: FileEntry[];
  /** Values included in run-file freshness checks; omission contributes no extra inputs. */
  runFilesInputs?:
    | /** Names of invocation environment variables to capture when present. */ string[]
    | /** Compute inputs in the runFilesInputs phase, before deciding whether files are stale. */ {
        /** Must emit a JSON object whose values are strings. */
        command: Command;
      };
  /** Ordered, idempotent infrastructure hooks in dev setup, after run files are available. */
  setup?: Step[];
  /** Services in startup order, with unique names; validated recipes require at least one spawn. */
  servers: Server[];
  /** Maximum live workspace stacks; omission or zero disables the cap. Resolved at startup. */
  maxConcurrentDevServers?:
    | /** Fixed nonnegative safe integer. */ number
    | /** Invocation-environment binding with a fallback. */ EnvNumber;
  /** Post-start output; omit to use the kernel's default dev-stack summary. */
  summary?: TextOutput;
}

/** A nonnegative safe integer read from the invocation environment rather than at config load. */
export interface EnvNumber {
  /** Variable name; when present its value must contain only decimal digits and fit a safe integer. */
  env: string;
  /** Fallback used only when the variable is absent; must itself be a nonnegative safe integer. */
  default: number;
}

/** A supervised foreground process or commands that manage an external service. */
export type Server =
  | /** AlignFirst owns the spawned process and waits for a readiness log match. */ {
      /** Selects supervised process startup. */
      kind: "spawn";
      /** Unique service identifier, also used for its log file. */
      name: string;
      /** Long-running foreground command executed in the start phase. */
      exec: Command;
      /** Port used for availability checks; omit for a service without a checked port. */
      port?:
        | /** Name from devServer.ports.declare, resolved to this workspace's allocation. */ string
        | /** Fixed TCP port, independent of named allocation. */ number;
      /** Readiness detector required before startup can complete. */
      ready: {
        /** Regular-expression source matched against captured process logs. */
        log: string;
      };
      /** Optional failure detectors for startup logs; omit to rely on process exit/readiness. */
      error?: ServerError;
    }
  | /** Start/stop commands manage a service outside AlignFirst's process supervision. */ {
      /** Selects one-shot lifecycle commands. */
      kind: "command";
      /** Unique service identifier used in startup and stop diagnostics. */
      name: string;
      /** One-shot start command; successful exit completes this service's startup. */
      start: Command;
      /** One-shot stop command; omission performs no service-specific stop action. */
      stop?: Command;
    };

/** Optional startup failure detectors for a spawned service; configured detectors are combined. */
export interface ServerError {
  /** Detect common Node.js errors in logs even if the process remains running. */
  preset?: "node";
  /** Additional regular-expression source whose log match marks startup as failed. */
  log?: string;
}

/** Effective configuration/storage metadata reported by a host CLI, without loading runtime state. */
export interface WorkspaceConfigReport {
  /** Selected logical configuration file, including its project/companion placement. */
  location: ConfigFileLocation & {
    /** Root selected by host project discovery. */
    in:
      | /** Configuration selected within the project. */ "project"
      | /** Configuration selected within its companion directory. */ "companion";
  };
  /** Absolute directory containing the effective shared workspace registries. */
  registryDir: string;
  /** Absolute runtime directory for the current target, including logs and setup state. */
  runtimeDir: string;
  /** Loaded host schema version, or null when no configuration was loaded. */
  schemaVersion:
    | /** Version declared by the selected configuration. */ number
    | /** No selected configuration was loaded. */ null;
  /** Declared allocation bounds, or null when no port configuration is present. */
  portRange:
    | /** Inclusive project-wide allocation range. */ PortRange
    | /** No dev-server ports declared. */ null;
  /** Whether a devServer section is configured, regardless of whether a stack is running. */
  hasDevServer: boolean;
}

/** A selected JSON/JSONC family member, or the default JSON path when the family is absent. */
export interface ConfigFileLocation {
  /** Selected path, relative or absolute according to the directory supplied to family resolution. */
  path: string;
  /** Whether a directory entry exists; broken symlinks count as present even if reading will fail. */
  exists: boolean;
}
