# Configuration File

A project has at most one selected configuration file: `alignfirst.json` (strict JSON) or `alignfirst.jsonc` (comments and trailing commas allowed). Both extensions in the selected location are an error. `{{CMD}} setup init` writes `alignfirst.json`; rename it to `.jsonc` when comments are wanted.

## Baseline

```json
{
  "schemaVersion": 1,
  "conventions": {
    "ticketIdPattern": "^\\d+$",
    "git": {
      "defaultBranch": "main",
      "branchNameTemplate": "{TICKET_ID}/{slug-1-3-words}",
      "commit": { "style": "conventionalCommit", "ticketReference": "bracketedHash" },
      "agentCoauthoring": false
    }
  },
  "plans": { "repositoryFolder": "acme-web", "autoArchive": true }
}
```

Keep only the optional fields that apply.

## Sections

| Section | Content | Topic |
| --- | --- | --- |
| `conventions` | Ticket IDs, default branch, branch names, commits, agent attribution | `{{CMD}} setup guide protocols` |
| `plans` | Work-files repository folder and automatic archival | `{{CMD}} setup guide work-files` |
| `assistantInstructionsFile` | Relative path of the assistant guide | `{{CMD}} setup guide assistant-project` |
| `workspace`, `devServer` | Workspace preparation, ports and services; port ranges belong only in `devServer.ports` | `{{CMD}} setup guide workspace` |

## Format rules

- One required `schemaVersion: 1` covers all sections.
- The optional `$schema` is URI-valued editor metadata. It is never fetched and never selects the validation.
- The editor schema ships at `alignfirst/schemas/alignfirst-v1.schema.json`. Validation uses the packaged schema, without network requests.
- Unknown properties and unsupported schema majors fail with upgrade guidance. An invalid file never falls back to defaults.
- Compatible additions keep the major. A future breaking major comes with sequential in-memory converters, retained through the CLI major. Reading never rewrites committed files.
- Retired wrappers and `.alignfirst.json` have no converter; see `{{CMD}} setup guide upgrade-workspaces`.

## Discovery and selection

Discovery starts at the root of the current Git worktree, including from a nested directory. Outside Git, it uses the caller's directory.

A companion can hold the configuration: its `alignfirst` item selects the whole `alignfirst.json`/`.jsonc` family. Sections are never merged across sources. See `{{CMD}} setup guide companion`.

`{{CMD}} config --json` reports the effective configuration with canonical field names, and `locations.alignfirst` names the selected file or the `.json` destination. Reports execute no commands and resolve no environment bindings, but authored literals, including executable sections and environment settings, may appear in reports and logs. Keep credentials in environment variables or ignored files.
