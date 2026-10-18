---
title: Pi Extensions
summary: The independent subagent and background packages, their ownership boundary, and regression checks.
read_when:
  - changing Pi subagent dispatch, background jobs, cleanup or completion notices
  - integrating a persistent Pi assistant or a headless Pi coding child
  - testing or packaging the Pi extensions
---

# Pi Extensions

Two independently installable MIT packages extend Pi without requiring AlignFirst, AlignDev, git or each other:

| Package | Source | Responsibility |
| --- | --- | --- |
| [`@alignfirst/pi-subagent`](../packages/pi-subagent/README.md) | `packages/pi-subagent/src/` | Synchronous isolated Pi children through `subagent`, with a bundled worker, optional profiles, parallel and chain modes. |
| [`@alignfirst/pi-background`](../packages/pi-background/README.md) | `packages/pi-background/src/` | Arbitrary attached shell commands through `background`, prompt startup acknowledgement, bounded output, status/cancellation and native follow-up requests. |

Each package exposes compiled `dist/index.js` through `pi.extensions`. Imported Pi libraries and TypeBox are host peers, not bundled runtime copies. Public schemas, output bounds, examples and provenance are maintained in the linked READMEs. `packages/pi-subagent/src/run.ts` defines its parameters/results; `packages/pi-background/src/background-tool.ts` defines its action union/results. Neither package installs profiles or skills. Disable an existing local `subagent` implementation explicitly before loading its packaged replacement; keep user profiles.

## Integration boundary

[AlignDev](aligndev-architecture.md) chooses the child adapter, protocols, prompt, worktree and durable run identity. A persistent Pi assistant launches ordinary `aligndev code new/resume ... --quiet --meta <unique-run-key>` through `background`. The assistant retains the original worktree, generic handle, unique key, exact resolved run-file path and child conversation ID separately. On a completion notice it checks handle ownership, then retrieves `code status <exact-file> --result`, resolving by the unique meta key only when the path is not yet known. The CLI owns companion resolution and reconciliation. Result-only output excludes the transcript but has no numeric final-text cap.

The parent host and selected child are independent. The assistant never replaces `aligndev code` with a direct `subagent` call. A Pi coding child can use synchronous subagents, including in headless operation, with normal provider configuration and saved project trust. Installing the AlignDev skill supplies instructions only. See [coding-agent assistant setup](../skills/alignfirst-setup-guide/references/coding-agent-assistant.md).

## Runtime ownership and cleanup

Loading only registers capabilities. Work belongs to the active runtime, session and tree branch. Retirement invalidates authority before asynchronous cleanup; late callbacks cannot submit new notices for the replacement owner. An ordinary parent turn ending leaves accepted background jobs running. A synchronous call waits for its children, and interruption cancels those children. Interrupted startup cancels unacknowledged background work.

Shutdown, session replacement, reload and successful navigation to a different tree point stop owned work. Merely opening or cancelling the tree picker does not stop it. Commands must stay attached; no daemonization or detachment is supported. Cleanup sends TERM immediately, escalates after a shared five-second graceful window, and awaits bounded direct-child reaping and pipe draining. Jobs stop concurrently. Incomplete cleanup remains an explicit error with retained ownership for retry, not a successful cancellation. Crash/SIGKILL recovery and deliberately escaped daemons are outside the guarantee.

Each package has its own small `process-tree.ts` leaf so installation stays independent. Propagate generic fixes and conformance tests to both copies. They supervise observable attached descendants and retained process groups, including Pi's separately grouped bash work. This is process ownership, not an OS sandbox.

## Notices are not workflow completion

Natural background completion attempts one small native `sendMessage` with `triggerTurn: true` and `deliverAs: "followUp"`. The notice carries origin and handle metadata, not full commands, delegated prompts or logs. It is a wake hint, not an acknowledgement that the model consumed it. Validate the handle with `background` status before taking workflow action; unknown/retired handles or inactive origins authorize none.

During standalone manual compaction and navigation, unsafe handoffs remain **local pending notices**. Failed/cancelled navigation has no public terminal event, so held notices can wait for a later ordinary turn, even after navigation or compaction has ended. That turn receives retained notices as context without another requested turn. Teardown discards local notices; there is no replay after reload.

Once submitted, a message is **Pi-owned**. Native follow-ups can survive interruption, navigation, reload or generic record clearing and appear later. The extension cannot selectively retract them and never rewrites native queues. Native queue clearing can instead remove them permanently. There is no exactly-once delivery, retry timer or autonomous continuation guarantee. A one-shot print/JSON Pi process exits rather than remaining available for background reporting.

## Supported and tested baseline

Both packages target **Pi 1.3.0**, require **Node.js 22.19.0 or later**, and start at **0.0.0**. Deterministic package/host tests have run on **Linux**, **Node 26.8.1**, with local scripted providers. macOS and Windows through WSL are supported targets awaiting platform acceptance; native Windows is refused before launch. Host peer ranges of `*` follow Pi packaging rules and do not certify future versions.

The deterministic matrices cover public tools, bounded results, ownership races, real descendants, headless subagents, native idle/busy delivery and lifecycle replacement. They establish host mechanics, not live model obedience. Packed installation, live Terra acceptance and AlignDev end-to-end checks are separate gates. Pi work does not certify or migrate the outstanding Claude/Codex/OpenClaw completion paths.

## Checks

From the repository root:

```sh
fnm exec --using=.nvmrc npm test --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm test --workspace @alignfirst/pi-background
fnm exec --using=.nvmrc npm run typecheck --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run typecheck --workspace @alignfirst/pi-background
fnm exec --using=.nvmrc npm run build --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run build --workspace @alignfirst/pi-background
fnm exec --using=.nvmrc npm run lint --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run lint --workspace @alignfirst/pi-background
```

Use disposable Pi settings/session directories and explicitly loaded extensions. Do not modify installed extensions, global trust/settings or expose credentials to test discovery. Follow [Releasing](releasing.md#adding-a-package-name) for the owner's new-name bootstrap and trusted-publisher prerequisites; documentation does not authorize publication.
