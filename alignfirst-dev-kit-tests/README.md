# alignfirst-dev-kit-tests

Dockerised regression-test harness for the `myassistant` reference workspace at [`workspace/`](workspace/). Local-only. Manually run.

Standalone consumer of the `@alignfirst/openclaw-*` packages (own `package-lock.json`, not part of the root npm workspaces). See upstream docs for the generic mechanics:

- [packages/openclaw-test/README.md](../packages/openclaw-test/README.md) — install, configure, run, scenario primitives, artifact layout.
- [docs/alignfirst-dev-kit/openclaw-test-architecture.md](../docs/alignfirst-dev-kit/openclaw-test-architecture.md) — internals.

This README only documents what is specific to this harness.

## Install & run

```sh
cp .env.local.example .env.local
# Edit .env.local — fill OPENROUTER_API_KEY and select ALIGNFIRST_CODE_AGENT

# Build the real alcode, alignfirst, and alproject CLIs the gateway runs.
npm run build --prefix ..

npm run vendor   # build + pack the local @alignfirst/openclaw-* into vendor/ (first run only; env:build repeats it)
npm install
npm run env:build
npm run env:up
npm run e2e -- --model gpt-5.6-terra --channel all A08-go-ahead-delegation
npm run env:down
```

See the upstream README for all flags. `--parallel K` (or `OPENCLAW_TEST_PARALLEL` in `.env.local`) runs cells concurrently on K worker stacks; per-worker workspace copies land in `.workers/` (gitignored). When upgrading from a pre-parallel version, tear down the legacy un-suffixed Compose project once: `docker compose down` from this dir.

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Each run lands in its own **timestamped** subdir, so runs accumulate without colliding — deleting the directory throws away prior runs you may still need. These are bind-mount outputs; leave them in place.

## Configuration

- `OPENCLAW_WORKSPACE_DIR=./workspace` — the `myassistant` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `OPENCLAW_CODEX_HOME` — absolute path to a file-backed Codex home. Required for `openai/gpt-5.6-terra`. The gateway mounts it read-only and uses the ChatGPT/Codex subscription; no OpenAI Platform API key is required. Create a dedicated login so test authentication is isolated from the main Codex session:

  ```sh
  mkdir -p .codex-home
  CODEX_HOME="$PWD/.codex-home" codex login --device-auth
  CODEX_HOME="$PWD/.codex-home" codex login status
  ```

  Then set `OPENCLAW_CODEX_HOME` in `.env.local` to `$PWD/.codex-home` with `$PWD` expanded to its absolute value. Repeat the login when the stored access token expires.
- `ALIGNFIRST_PLAYBOOK_SKILL_DIR` — renamed from `ALIGNFIRST_DEVELOPER_PLAYBOOK_SKILL_DIR`, and its value moved with the skill directory; host path to the `alignfirst-openclaw-playbook` skill, bind-mounted at `/home/assistant/.openclaw/skills/alignfirst-openclaw-playbook` in OpenClaw's managed skill directory. Playbook edits iterate live, no rebuild.
- `ALIGNFIRST_REPO_DIR` — host path to the monorepo root (build it first). Live-mounted read-only at `/opt/alignfirst`; the `alcode`, `alignfirst`, and `alproject` wrappers run all three CLIs from the checkout. Alcode runs for real, while both `claude` and `codex` resolve to the mock through PATH. Delegation instructions come from `alcode --openclaw-guide` (rendered from `packages/alcode/templates/`, so guide edits iterate live).
- `ALIGNFIRST_CODE_AGENT=codex|claude` — required selector for alcode's child. It does not affect the OpenClaw conversation model. `ALIGNFIRST_CODE_MODELS` optionally narrows the agent models or pins a full Codex slug.
- [`docker-compose.yml`](docker-compose.yml) — one shared fixture volume on gateway + runner at
  `/home/assistant/projects`; the skill and monorepo bind mounts on `gateway`;
  `OPENCLAW_TEST_JUDGE_MODEL` defaults to `openrouter/anthropic/claude-haiku-4.5` on `runner` and
  accepts a host override.

## Fixtures

Each scenario starts fresh: [`scripts/reset-fixture.mjs`](scripts/reset-fixture.mjs) (run via `ctx.execInGateway(...)`) materializes three Git repositories on `main`, copied from the committed [`projects-fixture/template/`](projects-fixture/template/). `nimbus` and `lumen` live under `/home/assistant/projects`; `orion` lives under `/home/assistant/projects/external-projects`. Each project has `.alignfirst.json`, a project-specific package name, `README.md` and `DEVELOPERS.md` headings, its own 20-port block (6500, 6520, and 6540), and an untracked `.plans/` directory.

The root and its nested `external-projects` and `lifecycle-projects` directories carry `.alignfirst-projects.json` markers with descriptions and a default `portRanges` entry. The lifecycle directory resets empty; the creation scenario uses it for `nova`. Removal scenarios seed a real linked `nimbus` workspace and a sibling additional directory after reset.

`alproject` runs for real against the fixture tree and calls `alignfirst config --json` in each child. Scenarios assert on the agent's exec calls and on the filesystem.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` are skipped by discovery. The suite has 23 scenarios. Related states run sequentially in one conversation to share startup and workspace setup.

`bootstrapThreadFromChannel` sends the channel request, observes one native starter and one `thread_handoff start`, and checks that the parent performed no target work. The plugin injects `Take over this thread.` from `AlignFirst Service`. The thread session reads the starter and owns the work. `sendInThread` supplies missing values, holds, confirmations, and subsequent requests.

| Scenario | Coverage and consolidation |
| --- | --- |
| A01 | Missing ticket and scope, quiet takeover, human answer, workspace and delegation; Discord title gains the supplied ticket. |
| A02 | Complete request starts automatically on external project `orion`; canonical path survives through delegation. |
| A03 | A question without a ticket refreshes main before read-only investigation and reports concise, substantive findings without creating a ticket or workspace. |
| A04 | Ticket supplied without a project: ask which project and wait. |
| A05 | An unknown project name must be corrected before work starts. |
| A06 | Small talk stays social and starts no project work. One message suffices; the former second message had no additional assertion. |
| A07 | Status progresses from no branch to an externally created branch and its attached workspace. A repeated status with no state change is omitted. Checks actual filesystem state and report meaning, with no template requirement. Its mock reports status without claiming implementation work. A16 covers reuse of an existing workspace and the discovery of one that predates the session. |
| A08 | Human hold during takeover, workspace setup, explicit release, first background coding run, then a second request and coding run in the same thread. Covers the alcode/background contract and later-run delivery. Observes the real completion chain and checks that final reporting stays quiet afterward. |
| A09 | Deterministic alcode new/resume, selected-agent protocol, catchup, recorded context size, and failure handling. Run once per selected coding agent; it does not use a conversation model or channel behavior. |
| A10 | With one listed project, a ticket-only request selects it automatically. |
| A11 | Duplicate project names require choosing a canonical path; takeover waits for the answer. |
| A12 | New project creation, initial commit, and setup on main without a ticket protocol. The report confirms completion; CLI and filesystem assertions verify port allocation without requiring the report to repeat configuration fields. |
| A13 | A preparation request asks for the exact paths before confirmation, followed by failed removal of a dirty worktree, preservation of all paths/config, then cleanup and an explicitly reconfirmed successful retry. Covers ordered deletion, final inventory refresh after removal, and sibling-directory protection. |
| A14 | A casual mention of a listed project is recognized as project work. |
| A15 | A concrete action with neither project nor ticket still opens a thread and asks for its project. |
| A16 | A PR URL carries through resource resolution, ticket recovery, review delegation, and reported findings. The fresh thread discovers and reuses a preexisting registered workspace, preserving the cold-discovery boundary without another startup. |
| A17 | One multi-project request acknowledges the active takeover, uses the approved readiness wording, and delegates a base refresh separately in each canonical project. |
| A18 | A multiline request survives the starter and request-file capture before coding. Its missing-ticket question may appear in the starter or the thread. |
| A19 | Explicit no-ticket work reserves the next side ticket and captures the complete request. File observation does not require setup to remain paused while the test polls. |
| A20 | A genuine missing-ticket answer races initial takeover; it must become the fresh session's reaction target and reach the working session. |
| A21 | One native starter delivery fails; retry reuses the target and automatically starts the work. |
| A22 | A question about an explicit branch reuses its registered workspace for read-only investigation. |
| A23 | A human opens the thread and tags the bot inside it: no starter, no handoff. The fresh session reacts to the latest message, resolves the project itself, opens no second thread, and leaves the author's thread name alone. |

A04, A10 and A15 retain separate fresh conversations because absent-project inference depends on both the initial message and the inventory. A01 and A18 distinguish a missing task description from a complete detailed request. A20 keeps its startup race separate from A08's explicit hold.

Scenario numbers are contiguous and describe the suite as it stands. Dated references elsewhere in the docs (`A05 Slack, 2026-09-08`, artifact directories, …) use the numbering in force on that date and are left as recorded.

Starter values, canonical paths, full detailed requests, and actual session ownership are checked structurally. Scenario-specific judges cover meaning where needed, including missing-information questions and A18’s request fidelity. The former generic starter judge repeated these checks at every thread bootstrap and rejected valid summaries; it is removed.

The fresh-session reaction helper observes a claim, history read, and lobster reaction in that order. It verifies that the reaction targets the newest visible message from the read snapshot and is the first surface mutation. The quiet-takeover helper then waits for a terminal turn before checking that the starter's question was not repeated. A17 applies the structural reaction assertion to an active takeover and checks the approved readiness meaning. A23 applies it to a human-created thread whose claim returns `none`. The helper does not require an ID in the nudge, a particular silent token, or a fixed 90-second delay. Completion checks require the real chained process to exit, its report to arrive, and the target thread to settle for three seconds without more messages. The only system event is the guide's chained completion command, run by the agent; the suite injects none itself. Native notices are recorded when observed; OpenClaw may defer them until its next scheduled tick, so the suite does not promise to exercise every later notice or count unrelated finalizers in gateway-wide logs.

From this directory, rebuild the CLIs and harness image, then run 22 conversation scenarios on both surfaces with Terra. Run the deterministic A09 contract once for the selected coding agent.

```bash
npm run build --prefix ..
npm run env:build

scenario_names=()
for scenario_file in scenarios/A*.ts; do
  case "$scenario_file" in scenarios/A09-*) continue ;; esac
  scenario_name="${scenario_file##*/}"
  scenario_names+=("${scenario_name%.ts}")
done
ALIGNFIRST_CODE_AGENT=codex npm run e2e -- --model gpt-5.6-terra --channel all "${scenario_names[@]}"
ALIGNFIRST_CODE_AGENT=codex npm run e2e -- --channel slack-mock A09-alcode-agent-contract
```

For a focused pass, supply only the affected scenario names instead of the array. After Terra passes, use A08 on Slack for the representative Sonnet compatibility check. Expand Sonnet coverage only to diagnose a Sonnet-specific failure. If the selected coding agent changes to Claude, run A09 once with `ALIGNFIRST_CODE_AGENT=claude`; channel/model repetition adds no coverage to that contract.

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …; `A11` → `ABC-0110`). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `ROBIN01`, listed in [`workspace/USER.md`](workspace/USER.md). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

## Vendored packages

This harness vendors the **local** sources of the four generic `@alignfirst/openclaw-*` packages and
`@alignfirst/service-openclaw-plugin`.
The dependencies are `file:vendor/<pkg>.tgz`; [`scripts/vendor-packages.mjs`](scripts/vendor-packages.mjs)
builds each package and `npm pack`s it into `vendor/` (gitignored). The Docker build context is this
directory, so the tarballs must live here.

`npm run env:build` chains `vendor` → `npm install` (refreshing `package-lock.json`) →
`openclaw-test env build`, so a source edit in any of the five packages is picked up on the next
build. Run `npm run vendor` before the first standalone `npm install`; the tarballs must exist for
resolution.

The plugin is explicitly allowlisted, loaded from its installed package path, and exposes optional
tool `thread_handoff`. Slack uses `replyToMode: "off"`; Discord remains non-automatic. Both surface
IDs map to their native receipt contract in `plugins.entries.alignfirst-service.config.channelSurfaces`.

The complementary deterministic suite makes no model calls and runs outside Docker against the
pinned OpenClaw 2026.9.5 executable:

```sh
KEEP_THREAD_HANDOFF_ARTIFACTS=1 npm run test:integration --workspace @alignfirst/service-openclaw-plugin --prefix ..
```

It retains test-owned gateway logs, scripted-provider requests, configuration, and SQLite restart
state under `/tmp/thread-handoff-*`. Omit the environment variable to clean fixtures automatically.

## Layout

- [`openclaw.json`](openclaw.json) · [`docker-compose.yml`](docker-compose.yml) · [`Dockerfile`](Dockerfile) · [`package.json`](package.json) · [`scripts/vendor-packages.mjs`](scripts/vendor-packages.mjs) — committed.
- [`sandbox/inbound.sh`](sandbox/inbound.sh) — manual inbound-message helper; see [`manual-gateway-sandbox.md`](../docs/alignfirst-dev-kit/manual-gateway-sandbox.md).
- `vendor/` (gitignored) — locally-built `@alignfirst/openclaw-*` tarballs, regenerated by `npm run vendor`.
- `.env.local` (gitignored) — API keys, workspace/skill/repository paths, and `ALIGNFIRST_CODE_AGENT`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `raw-stream.jsonl` (opt-in). Session transcripts live in the gateway's SQLite store; each cell's artifact dir archives them as `transcripts.json`.
