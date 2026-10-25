---
title: Running the OpenClaw Tests
summary: Configure and run AlignDev's local OpenClaw regression harness, select scenarios, preserve artifacts, and maintain its fixtures.
read_when:
  - running AlignDev's OpenClaw regression scenarios
  - configuring model credentials or the coding agent for the test harness
  - changing scenarios, fixtures, or vendored harness packages
  - investigating test artifacts or cross-scenario state
---

# Running the OpenClaw Tests

The [`aligndev-openclaw-tests`](../../aligndev-openclaw-tests/) directory contains the local, manually run regression harness for the `myassistant` reference workspace.

The harness is a standalone consumer of the `@alignfirst/openclaw-*` packages. It has its own `package-lock.json` and is not part of the root npm workspaces. See the upstream documentation for generic mechanics:

- [`packages/openclaw-test/README.md`](../../packages/openclaw-test/README.md) — generic installation, configuration, scenario primitives, and artifact layout.
- [OpenClaw Test Harness Architecture](./openclaw-test-architecture.md) — internals.

This guide documents what is specific to the AlignDev harness. Run its commands from `aligndev-openclaw-tests/` unless stated otherwise.

## Install and run

```sh
cp .env.local.example .env.local
# Configure OPENROUTER_API_KEY, OPENCLAW_CODEX_HOME, and CODING_AGENT as described below.

# Create bind-mount outputs as your user so Docker does not create root-owned directories.
mkdir -p artifacts .gateway-logs

# Build the real aligndev and alignfirst CLIs the gateway runs.
npm run build --prefix ..

# Build and pack local packages, install them, then build the harness image.
npm run env:build
npm run env:up
npm run e2e -- --model gpt-5.6-terra --channel slack-mock A03-question
npm run env:down
```

`--channel` selects `slack-mock`, `discord-mock`, `webchat` (the OpenClaw apps, driven through the gateway methods they use) or `all`. A scenario runs only on the surfaces it supports; see [Scenarios](#scenarios).

See the upstream README for all flags. `--parallel K` (or `OPENCLAW_TEST_PARALLEL` in `.env.local`) runs cells concurrently on K worker stacks; per-worker workspace copies land in `.workers/` (gitignored). When upgrading from a pre-parallel version, tear down the legacy un-suffixed Compose project once: `docker compose down` from `aligndev-openclaw-tests/`.

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Each run lands in its own **timestamped** subdir, so runs accumulate without colliding — deleting the directory throws away prior runs you may still need. These are bind-mount outputs; leave them in place.

The reviewed toolchain is Node 26, npm `12.2.0`, Corepack `0.36.0` and pnpm `12.14.0`. Run local npm 12 commands without a global install, for example `fnm exec --using=.nvmrc npx --yes --package=npm@12.2.0 npm run env:build --prefix aligndev-openclaw-tests` from the repository root. npm 12 blocks dependency lifecycle scripts by default; the root and standalone manifests approve only the reviewed OpenClaw, esbuild and koffi versions. GenAI's no-op and protobufjs's warning-only scripts stay disabled. Re-review these policies when their versions change.

The generic host CLI can alternatively run on Bun 1.4.4 via `bunx --bun @alignfirst/openclaw-test` or explicitly Bun-owned scripts. This does not change the reviewed npm build/vendor/lockfile workflow above or the Node container toolchain. For a new Bun consumer, follow init's Docker Node/npm lockfile-preparation instructions before image builds; see the [package README](../../packages/openclaw-test/README.md#init). Docker, OpenClaw and native coding agents retain their own prerequisites.

## Shared-daemon isolation

Use a disposable consumer copy with a unique basename for concurrent work. Copy `.dockerignore` before any private environment file; it must exclude `.env.local`, `node_modules`, `.workers`, artifacts and logs. Keep credential stores outside the build context. Copy current non-secret inputs and vendor tarballs, then use reviewed npm `ci`; never run the copy's repository-relative vendor script.

The stock CLI writes the version-only base tag `paleo/openclaw-test-base:<package-version>` and derives worker project names from the consumer basename. Exporting `OPENCLAW_TEST_BASE_TAG` or `COMPOSE_PROJECT_NAME` does not override those decisions. For concurrent acceptance, bypass `env build`, `env up` and `run` with manual builds and raw Compose:

1. Choose a nonce-qualified base tag, a unique consumer image and an explicit unique Compose project. For example, use `0.23.3-side-27-<nonce>`, `side-27-openclaw-<nonce>:acceptance` and `side-27-openclaw-<nonce>-w1`. Keep package versions unchanged.
2. Build the installed package's unchanged `Dockerfile.base` with the caller's UID/GID. Build only Compose's `bus` target; all services share its image. Select the local-image-store builder per command, without changing the global builder:

   ```sh
   # HARNESS_RUN and all path overrides below must be absolute.
   package_dir="$HARNESS_RUN/node_modules/@alignfirst/openclaw-test"
   export OPENCLAW_TEST_BASE_TAG="0.23.3-side-27-$nonce"
   export OPENCLAW_TEST_CONSUMER_IMAGE="side-27-openclaw-$nonce:acceptance"
   project="side-27-openclaw-$nonce-w1"
   BUILDX_BUILDER=default docker build -f "$package_dir/Dockerfile.base" \
     --build-arg ASSISTANT_UID="$(id -u)" --build-arg ASSISTANT_GID="$(id -g)" \
     -t "paleo/openclaw-test-base:$OPENCLAW_TEST_BASE_TAG" "$package_dir"
   BUILDX_BUILDER=default docker compose -f "$HARNESS_RUN/docker-compose.yml" \
     -p "$project" build bus
   ```

   Here `default` is the Docker-driver builder on the default context. A container-driver builder cannot resolve a local-only base tag. Set absolute `OPENCLAW_TEST_PROJECT_DIR`, `OPENCLAW_TEST_PACKAGE_DIR`, workspace/config/scenarios/output paths and `ALIGNFIRST_REPO_DIR` before Compose. Pre-create writable bind-mount directories as the caller. Keep the dedicated Codex home outside the build context and mount it read-only.
3. Securely render a private runtime config using the runner's environment expansion, empty-key provider dropping and selected `agents.entries.main.model`. Keep expanded secrets outside artifacts/build contexts, with mode `0600`. For authorized Terra acceptance, select `openai/gpt-5.6-terra`, use the Haiku/OpenRouter judge and clear Anthropic/Z.AI keys. Forward the same private environment, config and worker paths on every Compose command.
4. Refresh a private worker workspace before each cell. Start only the owned bus/gateway with `up -d --no-build --pull never --force-recreate --wait bus gateway`. Invoke `run --rm --no-deps --pull never --use-aliases runner` with the scenario, channel, model ID/ref, iteration index/width, base stamp and results-directory arguments from `packages/openclaw-test/src/loop.ts`. Check both the runner exit and its cell JSON. Recreate between cells; do not use stack reuse.
5. Wait for every runner and tear down only the explicit owned project with the same Compose files and environment. Remove only its owned volumes/networks when needed. Preserve timestamped results and sanitized build/gateway logs. Inspect exact project/service labels and sanitized load errors; expanded Compose configuration can expose secrets.

Unique tags isolate names, not CPU, RAM, disk or build cache. Agree on a resource window, begin with one worker and limit owned services when needed. Never overwrite the shared version tag, prune the daemon or sweep unrelated projects. If using the stock CLI instead, coordinate exclusive ownership of its exact shared base tag through both builds, or use a genuinely separate daemon/image store.

## Configuration

Use only Terra (`openai/gpt-5.6-terra`) for conversation-model tests. The judge runs `openrouter/anthropic/claude-haiku-4.5` on `OPENROUTER_API_KEY`. The Anthropic, Qwen and GLM providers in `openclaw.json` stay as examples at their latest model versions; the runner drops a provider whose key is empty.

- `OPENCLAW_WORKSPACE_DIR=./workspace` — the `myassistant` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `OPENCLAW_CODEX_HOME` — absolute path to a file-backed Codex home. Required for `openai/gpt-5.6-terra`. The gateway mounts it read-only and imports its ChatGPT/Codex credential into the disposable `main` agent's OpenClaw auth store at startup; no OpenAI Platform API key is required. Create a dedicated login so test authentication is isolated from the main Codex session:

  ```sh
  mkdir -p .codex-home
  CODEX_HOME="$PWD/.codex-home" codex login --device-auth
  CODEX_HOME="$PWD/.codex-home" codex login status
  ```

  Then set `OPENCLAW_CODEX_HOME` in `.env.local` to `$PWD/.codex-home` with `$PWD` expanded to its absolute value. Repeat the login when the stored access token expires.

  Since 2026.9.6, OpenClaw does not use the mounted Codex `auth.json` directly for the OpenClaw runtime. The image's `gateway-entrypoint` copies the credential to a temporary writable directory, imports it with `openclaw migrate apply codex`, deletes the copy, then starts the gateway. Without `auth.json` it skips the import, so other providers need no Codex login. A failed import is reported and the gateway still starts. For Terra acceptance, investigate and fix that failure before running scenarios. `openclaw.json` routes the subscription credential through the ChatGPT Codex endpoint.

  The image build runs `openclaw update repair` followed by `openclaw doctor --fix` to settle deferred plugin state in this OpenClaw release. Recheck this workaround when changing the pinned OpenClaw version.

  The plugin installs, the repair and Doctor share one image layer, which then drops the plugin captures they left. Since 2026.10, loading a plugin with native binaries (Codex) hardlinks its files and checks the link's inode. Overlayfs gives a new inode to a lower-layer file with several links when the link copies it up, so a split layer or a leftover capture makes Codex fail to load: `Native plugin artifact changed during admission`.
- `ALIGNFIRST_REPO_DIR` — host path to the monorepo root (build it first). Live-mounted read-only at `/opt/alignfirst`; the `aligndev` and `alignfirst` wrappers run both CLIs from the checkout. `aligndev code` runs for real, while `claude`, `codex` and `pi` resolve to the mock through PATH. `aligndev guide` reads its templates at runtime, so edits iterate live: the playbook comes from `packages/aligndev/templates/guide/playbook/`, and the delegation instructions (`aligndev guide code`) from `packages/aligndev/templates/guide/code.md`.
- `CODING_AGENT=codex|claude|pi` — required mocked-child selector, independent of the OpenClaw conversation model. `CODING_AGENT_MODELS`, a comma-separated list, optionally replaces accepted model names or pins a full Codex slug/Pi-native selector. Both reach the gateway and runner. The pure `scripts/coding-agent-settings.ts` helper generates `code.profile: "harness"` and `code.profiles.harness: { agent, models? }`, with `platform: "openclaw"` and `projectsRoot: "/home/assistant/projects"`. The thin writer saves it to `/home/assistant/.alignfirst/aligndev.settings.json`; missing/invalid selectors fail startup. Empty model lists add no override or default model. A09 explicitly selects `terra` for Codex, `sonnet` for Claude or `openai/gpt-5.6-terra` for Pi; model-list overrides must allow that selection. Pi mocks need neither a real Pi CLI nor Pi credentials. Terra/OpenClaw's Codex credential import remains independent, including with a mocked Pi child.
- [`docker-compose.yml`](../../aligndev-openclaw-tests/docker-compose.yml) — one shared fixture volume on gateway and runner at `/home/assistant/projects`; the monorepo bind mount on `gateway`; `OPENCLAW_TEST_JUDGE_MODEL` defaults to `openrouter/anthropic/claude-haiku-4.5` on `runner` and accepts a host override.

## Fixtures

Each scenario starts fresh: [`scripts/reset-fixture.mjs`](../../aligndev-openclaw-tests/scripts/reset-fixture.mjs) (run via `ctx.execInGateway(...)`) materializes three Git repositories on `main`, copied from the committed [`projects-fixture/template/`](../../aligndev-openclaw-tests/projects-fixture/template/). `nimbus` and `lumen` live under `/home/assistant/projects`; `orion` lives under `/home/assistant/projects/external-projects`. Each project has `.alignfirst.json`, a project-specific package name, `README.md` and `DEVELOPERS.md` headings, its own 20-port block (6500, 6520, and 6540), and an untracked `.plans/` directory.

Workspace setup is portless. The dev-server wrapper allocates `frontend` and generates `local.env` on `dev` or `dev setup`; reset does not seed that file. `REMOTE_DEV_DOMAIN` takes precedence over `REMOTE_DEV_HOST`, then localhost. Both environment inputs participate in run-file invalidation. Registries live in `.local-wt/workspace-registry`.

The root and its nested `external-projects` and `lifecycle-projects` directories carry `.alignfirst-projects.json` markers with descriptions and a default `portRanges` entry. The lifecycle directory resets empty; the creation scenario uses it for `nova`. Removal scenarios seed a real linked `nimbus` workspace and a sibling additional directory after reset.

An OpenClaw managed worktree, created by a `webchat` conversation with `worktree`, lives in the gateway's state directory (`/home/assistant/.openclaw/worktrees/<fingerprint>/<name>`), outside the shared volume. Read it through `ctx.execInGateway`, for example `["git", "-C", path, "branch", "--show-current"]`. Run `pnpm workspace …` with the main worktree as `cwd`: from elsewhere, Corepack's pnpm rejects the project's pinned version.

`aligndev project` runs for real against the fixture tree and calls `alignfirst config --json` in each child. Scenarios assert on the agent's exec calls and on the filesystem.

A24 and A25 opt into [`scripts/lightweight-fixture.ts`](../../aligndev-openclaw-tests/scripts/lightweight-fixture.ts) after reset. It transforms only `nimbus` into a dependency-free ESM library with a real local origin and `npm test`. It removes the project workspace/dev scripts and provides missing or tracked plans, respectively. The tracked case keeps a recognizable `old-history.md`. Existing full-workspace fixtures and assertions remain unchanged. Offline tests also exercise shared untracked plans and an already prepared companion, including profile/other-item preservation and removal that retains shared targets.

The lightweight flow discovers worktrees through Git-backed `aligndev worktree list`, not directory naming. The assistant creates the worktree before coding delegation. Its `onPrompt` mock checks the request and branch, writes a small label change, runs the actual test and reports that result without server claims. Companion inspection runs in the gateway; those paths are not runner-local mounts.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` are skipped by discovery. The suite has 27 scenarios.

A scenario declares its surfaces with `export const surfaces: readonly string[] = ["webchat"];`, string literals only. Without the export, it runs on every channel except `webchat`. A26 and A27 run on `webchat` only; the other scenarios on the two channel mocks. `scenarios/_lib/app-conversation.ts` holds the app helpers: the judged reply wait, the banner, the delegation chain and the check that no `message` or `thread_handoff` call happened. Related states run sequentially in one conversation to share startup and workspace setup.

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
| A08 | Human hold during takeover, workspace setup, explicit release, first background coding run, then a second request and coding run in the same thread. Covers the `aligndev code`/background contract and later-run delivery. Observes the real completion chain and checks that final reporting stays quiet afterward. |
| A09 | Deterministic `aligndev code` new/resume, selected-agent protocol, catchup, recorded context size, and failure handling. Run once per selected coding agent; it does not use a conversation model or channel behavior. |
| A10 | With one listed project, a ticket-only request selects it automatically. |
| A11 | Duplicate project names require choosing a canonical path; takeover waits for the answer. |
| A12 | New project creation, initial commit, and setup on main without a ticket protocol. The report confirms completion; CLI and filesystem assertions verify port allocation without requiring the report to repeat configuration fields. |
| A13 | A preparation request asks for the exact paths before confirmation, followed by failed removal of a dirty worktree, preservation of all paths/config, then cleanup and an explicitly reconfirmed successful retry. Covers ordered deletion, final inventory refresh after removal, and sibling-directory protection. |
| A14 | A casual mention of a listed project is recognized as project work: a thread opens with the canonical path, and the starter asks for no ticket. The scenario ends at the handoff. |
| A15 | A concrete action with neither project nor ticket still opens a thread and asks for its project. |
| A16 | A PR URL carries through resource resolution, ticket recovery, review delegation, and reported findings. The fresh thread discovers and reuses a preexisting registered workspace, preserving the cold-discovery boundary without another startup. |
| A17 | One multi-project request acknowledges the active takeover, uses the approved readiness wording, and delegates a base refresh separately in each canonical project. |
| A18 | A multiline request survives the starter and request-file capture before coding. Its missing-ticket question may appear in the starter or the thread. |
| A19 | Explicit no-ticket work reserves the next side ticket and captures the complete request. File observation does not require setup to remain paused while the test polls. |
| A20 | A genuine missing-ticket answer races initial takeover; it must become the fresh session's reaction target and reach the working session. |
| A21 | One native starter delivery fails; retry reuses the target and automatically starts the work. |
| A22 | A question about an explicit branch reuses its registered workspace for read-only investigation. |
| A23 | A human opens the thread and tags the bot inside it: no starter, no handoff. The fresh session reacts to the latest message, resolves the project itself, opens no second thread, and leaves the author's thread name alone. |
| A24 | No workspace tooling, missing plans and explicit no-ticket work. Snapshots registration, plans and Git state before approval; requires separate companion preparation, explicit selection, side-ticket/request capture before real worktree creation, then coding from that worktree. |
| A25 | No workspace tooling and tracked project plans. Uses the same approval gate; old history remains byte-identical in the repository and absent from the companion, with no copying offer or operation. New request/session files use the selected companion without a generated plans link. |
| A26 | `webchat`. Home answers a change request with one reply asking for a new conversation and does no project work. A new conversation on the agent workspace resolves `nimbus` from the inventory, sets up the ticket's workspace, posts the banner, and delegates in the background with the chained wake of its own key; the completion report lands in the same conversation. |
| A27 | `webchat`. A conversation on a fresh managed worktree of `nimbus` switches it to a new `ABC-0271/…` branch without asking, registers it with `workspace setup`, and stops at the banner with status `ready`. No sibling worktree, no coding run. |

A04, A10 and A15 retain separate fresh conversations because absent-project inference depends on both the initial message and the inventory. A01 and A18 distinguish a missing task description from a complete detailed request. A20 keeps its startup race separate from A08's explicit hold.

Scenario numbers are contiguous and describe the suite as it stands. Dated references elsewhere in the docs (`A05 Slack, 2026-09-08`, artifact directories, …) use the numbering in force on that date and are left as recorded.

Starter values, canonical paths, full detailed requests, and actual session ownership are checked structurally. Scenario-specific judges cover meaning where needed, including missing-information questions and A18’s request fidelity. The former generic starter judge repeated these checks at every thread bootstrap and rejected valid summaries; it is removed.

The fresh-session reaction helper observes a claim, history read, and lobster reaction in that order. It verifies that the reaction targets the newest visible message from the read snapshot and is the first surface mutation. The quiet-takeover helper then waits for a terminal turn before checking that the starter's question was not repeated. A17 applies the structural reaction assertion to an active takeover and checks the approved readiness meaning. A23 applies it to a human-created thread whose claim returns `none`. The helper does not require an ID in the nudge, a particular silent token, or a fixed 90-second delay. Completion checks require the real chained process to exit, its report to arrive, and the target thread to settle for three seconds without more messages. The only system event is the guide's chained completion command, run by the agent; the suite injects none itself. Native notices are recorded when observed; OpenClaw may defer them until its next scheduled tick, so the suite does not promise to exercise every later notice or count unrelated finalizers in gateway-wide logs.

### Scenario selection

After upgrades, select a few representative scenarios for the changed behavior. Never run the full matrix by default. Record the selected cases and what each checks. Start with one iteration on the relevant surface; use both surfaces when the change affects their shared contract. Conversation-model tests use Terra only, with Haiku through OpenRouter as judge.

For example, A01 exercises native handoff and A08 exercises background completion and later-run delivery. Choose A21 for retry changes or A20 for takeover races. These are selection examples, not a required combined set.

For authorized acceptance, rebuild the CLIs and harness image from `aligndev-openclaw-tests/`. This example selects two scenarios on Slack:

```bash
npm run build --prefix ..
npm run env:build
CODING_AGENT=codex npm run e2e -- --model gpt-5.6-terra --channel slack-mock --iterations 1 \
  A01-new-work-to-be-done A08-go-ahead-delegation
```

Inspect the cell results, transcripts and gateway logs. Investigate and fix unexpected errors before expanding coverage, then rerun the affected case to verify the fix. Additional scenarios, surfaces or iterations need a recorded coverage gap or diagnostic reason. A full matrix requires explicit justification; a failure alone is not a reason to launch one.

The app scenarios run on `webchat` only:

```bash
CODING_AGENT=codex npm run e2e -- --model gpt-5.6-terra --channel webchat \
  A26-app-conversation-from-home A27-managed-worktree-conversation
```

`--channel all` with a scenario list, or with `--all`, runs each scenario on its own surfaces. A selection that leaves a scenario no supported surface fails before any stack starts.

Run the deterministic A09 contract once for each coding agent affected by the change:

```bash
CODING_AGENT=codex npm run e2e -- --channel slack-mock A09-code-agent-contract
```

Select `CODING_AGENT=claude` or `CODING_AGENT=pi` for the other children as needed; channel/model repetition adds no coverage to that contract. Clear a previous `CODING_AGENT_MODELS` override or set it to include the selected child's contract model.

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …; `A11` → `ABC-0110`). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `ROBIN01`, listed in [`workspace/USER.md`](../../aligndev-openclaw-tests/workspace/USER.md). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

### side-29 acceptance — 2026-10-21

The final selected Slack cells used Terra and Haiku through OpenRouter, one iteration each:

| Case | Result | Artifact run under `aligndev-openclaw-tests/artifacts/` |
| --- | --- | --- |
| A24 missing plans | Passed | `2026-10-21T08-44-40-side29-B5` |
| A25 tracked plans | Failed before the approval gate: the starter omitted the detailed request | `2026-10-21T08-50-02-side29-B5` |
| A02 full-workspace control | Passed | `2026-10-21T08-53-04-side29-B5` |

A24's earlier diagnostic runs remain preserved. They exposed target-session observation and localized-question matching defects, overly literal request comparisons, and loss of the no-ticket instruction in short starters. The final fixture uses an itemized request and structurally checks every requirement while tolerating presentation and grammatical changes. The short-starter loss remains unresolved. The work-files guide now explicitly identifies `projects[companion.key]` after a model initially guessed the registry shape.

Discord was not run because the required Slack pass gate was not met. Tracked-plan approval remains unverified by a live conversation; the offline companion lifecycle covers its filesystem invariants. Offline suites, typechecks, lint and both manual disposable lifecycles passed. Evidence and diagnostic notes are under `.local/side-29/B5`; mocked child access does not establish native sandbox permissions.

### side-29 review corrections — 2026-10-21

The earlier results above describe the pre-review source. The corrected starter always carries the original Request block, short requests included. Side-ticket capture uses that block without losing explicit no-ticket intent. Rendered-guide tests and offline bootstrap negative controls reject omitted short or itemized constraints; the existing live assertions remain unchanged.

A focused A25 Slack rerun preserved the complete request but failed the approval judge because the question omitted the all-worktree scope (`2026-10-21T09-48-18-side29-C2`). Inspection confirmed that the guide was read and no preparation effects preceded approval. A narrow consent-question form now carries the scope and preservation promise together. One diagnosis-driven A25-only retry passed all approval/history/request/worktree/session assertions (`2026-10-21T09-55-57-side29-C2`). Both used Terra and the Haiku/OpenRouter judge on recreated gateways. Once that Slack gate passed, only the two planned A24 follow-ups ran:

| Final-source case | Result | Artifact run |
| --- | --- | --- |
| A25 tracked plans, Slack | Passed | `2026-10-21T09-55-57-side29-C2` |
| A24 missing plans, Discord | Passed | `2026-10-21T10-01-19-side29-C2` |
| A24 missing plans, Slack parity | Passed, including the final inventory/path assertion | `2026-10-21T10-06-06-side29-C2` |

No full matrix or extra short-request conversation cell ran. The owned stack and volumes were removed after all runners settled; artifacts were retained.

Final-source offline checks passed: 2,000 root package tests, four AlignDev built-CLI integration tests and 260 standalone harness tests. The broader 61-test integration run also passed; only guide prose changed afterward, and the affected AlignDev integration suite was rerun. Manual shared/companion lifecycles and nested locked/dirty/missing-child refusal passed. Evidence and conversation selection are under `.local/side-29/C2/`, separately from model artifacts. Initial `/tmp` quota failures were resolved by using private home-filesystem scratch directories, without deleting unrelated data.

Actual native Pi 1.3.0 with Terra read and wrote parent-verified nonce markers through ordinary shared project plans, a separate Git work-files repository and a prepared companion. These checks ran as host user `hop`, outside temporary-directory allowances. Pi uses ordinary OS access; this proves neither sandbox confinement nor deployment/service-account parity.

A separate native Codex 0.162.1/Terra probe used verified `--sandbox workspace-write` with no bypass. Worktree writes passed, but shared project `.plans` and `.local` writes returned `Errno 30` (read-only filesystem). The prepared-companion control passed through the existing narrow `--add-dir <companion>` grant; shared `.local` and outside-root writes remained denied. Shared Codex work-file access remains a limitation; no permission remedy or broad main-repository grant was introduced. Native Codex saved disposable-project trust records; read-only comparison confirmed the companion control changed no sandbox, approval or profile value. Native evidence, exact argv, marker verification, cleanup and limitations are in `.local/side-29/C2/native/evidence.md`.

### side-20 acceptance — 2026-10-24

The app conversations and the per-surface guide renders were validated with Terra and Haiku through OpenRouter, `CODING_AGENT=codex`, one iteration each:

| Case | Result | Artifact run under `aligndev-openclaw-tests/artifacts/` |
| --- | --- | --- |
| A26 app conversation from Home, webchat | Passed | `2026-10-24T20-09-56-815Z` |
| A27 managed-worktree conversation, webchat | Passed | `2026-10-24T19-46-21-010Z` |
| A01, A08, A23, Slack and Discord | Passed (6 cells) | `2026-10-24T20-09-56-815Z` |
| A09 code-agent contract, Slack | Failed, then passed after the fix | `2026-10-24T20-21-28-946Z`, `2026-10-24T20-23-35-480Z` |

Two earlier A26 runs answered Home with the project folder alone, dropping the agent workspace. The Home section now asks to keep both places when a project is listed; the rerun named both. A27 never writes in Home and was not rerun after that edit.

A09 read the `.running.md` path that `aligndev code` prints, but a run that has ended renames its file to `<stamp>.md`. The scenario now reads the completed file. The defect came from `main`, not from this change.

Pi and Claude children, the other scenarios and repeated iterations were not run. Offline suites, typechecks, lint, the integration suites and the deployment-template tests passed.

## Offline helper checks

From the repository root, using Node 26:

```sh
fnm exec --using=.nvmrc npm run build --workspace @alignfirst/docmap --workspace alignfirst --workspace aligndev
fnm exec --using=.nvmrc npm test --prefix aligndev-openclaw-tests
fnm exec --using=.nvmrc npm run typecheck --prefix aligndev-openclaw-tests
fnm exec --using=.nvmrc npm test --workspace aligndev -- test/code/pi-agent.test.ts
sh -n aligndev-openclaw-tests/scripts/gateway-entrypoint.sh
```

The Node built-in suite checks profile generation, native-agent bypass detection, all three new/resume mock streams against the built adapters, Pi fault queues and current-response context accounting. Its disposable fixture integration runs frozen pnpm installs and the actual workspace/dev lifecycle, including linked worktrees, project port isolation, URL input changes and server cleanup. Native state and writer destinations use temporary directories; unexpected service/provider/CLI operations fail. No scenario runner is imported. Lightweight fixture checks additionally run real AlignFirst/AlignDev worktree commands for shared, missing and tracked plans, discovery/reuse, branch consultation and no-branch status policies, and cleanup. Request-capture negative controls reject omitted requirements while tolerating markup and verb inflections. Parser-only stream permutations remain in AlignDev's Pi adapter tests. A09 source includes profile/session metadata, exact native argv, catchup and failure assertions.

The standalone suite also loads each surface's public factory from the installed vendor package. It verifies shared-host Zod resolution, nested host/local schema composition, invalid-settings rejection and concrete JSON Schema generation. Root source-path tests and CLI/Pi release smoke do not cover this packed OpenClaw boundary.

These offline checks do not start Docker, import credentials or execute any scenario, including A09. Record conversation-model results separately from offline checks. Mock success certifies neither Pi authentication/trust nor native service-account permissions. Live deployment acceptance, deployment parity and production headless waiting require their own evidence.

## Vendored packages

This harness vendors the **local** sources of the four generic `@alignfirst/openclaw-*` packages, `@alignfirst/service-openclaw-plugin` and their invocation provider `@alignfirst/docmap`. The provider is built and packed first so the installed harness resolves its new subpath from the local tarball, rather than an older registry release.

The dependencies are `file:vendor/<pkg>.tgz`; [`scripts/vendor-packages.mjs`](../../aligndev-openclaw-tests/scripts/vendor-packages.mjs) builds each package and `npm pack`s it into `vendor/` (gitignored). The Docker build context is `aligndev-openclaw-tests/`, so the tarballs must live in `aligndev-openclaw-tests/vendor/`.

`npm run env:build` chains `vendor` → `npm install` (refreshing `package-lock.json`) → `openclaw-test env build`, so a source edit in any vendored package is picked up on the next build. Run `npm run vendor` before a standalone `npm install`; the tarballs must exist for resolution.

The plugin is explicitly allowlisted, loaded from its installed package path, and exposes optional tool `thread_handoff`. Slack uses `replyToMode: "off"`; Discord remains non-automatic. Both surface IDs map to their native receipt contract in `plugins.entries.alignfirst-service.config.channelSurfaces`.

The complementary deterministic suite makes no model calls and runs outside Docker against the OpenClaw executable pinned in the root lockfile:

```sh
KEEP_THREAD_HANDOFF_ARTIFACTS=1 npm run test:integration --workspace @alignfirst/service-openclaw-plugin --prefix ..
```

It retains test-owned gateway logs, scripted-provider requests, configuration, and SQLite restart state under `/tmp/thread-handoff-*`. Omit the environment variable to clean fixtures automatically. Both surfaces cover abrupt pending and post-claim restarts, exact canonical session keys and continuation after restart. Immediate startup keeps its 20-second bound and `attemptCount: 1`; recovery deliberately records a second attempt.

To repeat that suite against a clean standalone packed install outside Docker, set `THREAD_HANDOFF_PACKED_ROOT` to its absolute consumer directory. The fixture selects that install's OpenClaw executable and installed channel/service plugins instead of repository package paths. Its scripted local provider makes no external model requests. This supplements image loading; it does not certify official plugin capture, credential import or Terra behavior.

## Layout

- [`openclaw.json`](../../aligndev-openclaw-tests/openclaw.json) · [`docker-compose.yml`](../../aligndev-openclaw-tests/docker-compose.yml) · [`Dockerfile`](../../aligndev-openclaw-tests/Dockerfile) · [`package.json`](../../aligndev-openclaw-tests/package.json) · [`scripts/vendor-packages.mjs`](../../aligndev-openclaw-tests/scripts/vendor-packages.mjs) — committed.
- [`sandbox/inbound.sh`](../../aligndev-openclaw-tests/sandbox/inbound.sh) — manual inbound-message helper; see [Manual Gateway Sandbox](./manual-gateway-sandbox.md).
- `vendor/` (gitignored) — locally-built harness, plugin and docmap tarballs, regenerated by `npm run vendor`.
- `.env.local` (gitignored) — API keys, workspace/repository paths, and `CODING_AGENT`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `raw-stream.jsonl` (opt-in). Session transcripts live in the gateway's SQLite store; each cell's artifact dir archives them as `transcripts.json`, and the gateway's OpenClaw log as `gateway.log`.
