import type { WorkspaceManifest } from "@alignfirst/workspace/config";

/** Host project metadata plus the workspace/dev lifecycle sections inherited from WorkspaceManifest. */
export interface ProjectConfig extends WorkspaceManifest {
  /** Required format discriminator for the supported AlignFirst configuration schema. */
  schemaVersion: 1;
  /** Optional schema URI for editor validation; runtime validation uses the bundled v1 schema. */
  $schema?: string;
  /** Ticket and Git guidance rendered by context and protocol commands; omit for built-in guidance. */
  conventions?: ConventionsConfig;
  /** Shared work-file organization and sync policy; omit to retain default behavior. */
  plans?: PlansConfig;
  /**
   * Explicit instructions-file path relative to the selected project or companion root. It must
   * remain within that root, including through symlinks. Omit when no file should be selected.
   */
  developerInstructions?: string;
}

/** Repository-specific guidance for ticket detection, branch names and commit messages. */
export interface ConventionsConfig {
  /**
   * Anchored regular-expression source for ticket IDs. Branch detection removes the outer anchors;
   * inner anchors are rejected. Omit to ask for ticket IDs rather than infer a configured format.
   */
  ticketIdPattern?: string;
  /** Git guidance overrides; omitted fields retain their individual defaults. */
  git?: GitConfig;
}

/** Git conventions used for rendered guidance and default-branch resolution, without changing Git. */
export interface GitConfig {
  /** Default branch override; omission uses an existing cached remote HEAD without fetching. */
  defaultBranch?: string;
  /** Suggested branch-name template, such as `{TICKET_ID}/{slug}`; omit for no template guidance. */
  branchNameTemplate?: string;
  /** Commit-subject guidance; omit for no configured subject format. */
  commit?: CommitConfig;
  /** False forbids coding-agent attribution in rendered guidance; omission adds no attribution rule. */
  agentCoauthoring?: boolean;
}

/** Conventional-commit subject guidance, with an optional ticket reference for non-side tickets. */
export interface CommitConfig {
  /** Selects `type: summary` as the base subject format. */
  style: "conventionalCommit";
  /** Ticket placement after `type:`; omission leaves the subject without a ticket reference. */
  ticketReference?:
    | /** Produces `type: [TICKET_ID] summary`; side tickets keep `type: summary`. */ "bracketed"
    | /** Produces `type: [#TICKET_ID] summary`; side tickets keep `type: summary`. */ "bracketedHash";
}

/** Organization of work files in their separate repository and optional automatic archival. */
export interface PlansConfig {
  /** Project subfolder within the shared work-files repository, used in setup and rendered guidance. */
  repositoryFolder?: string;
  /** Enable automatic archival during sync; defaults to false unless explicitly enabled by the CLI. */
  autoArchive?: boolean;
}

/** A successfully read configuration, before project/companion source attribution is attached. */
export interface ProjectConfigFile {
  /** Parsed configuration after schema and workspace semantic validation. */
  config: ProjectConfig;
}

/** Validated configuration selected by project layout discovery, with its logical source. */
export interface ResolvedProjectConfig extends ProjectConfigFile {
  /** Placement of the selected file; inherited config has the same validation contract. */
  source:
    | /** Selected from the project's configuration family. */ "project"
    | /** Selected from the registered companion's configuration family. */ "companion";
}
