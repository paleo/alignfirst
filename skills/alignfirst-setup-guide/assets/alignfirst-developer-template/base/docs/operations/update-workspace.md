---
title: Update the Workspace Files
read_when:
  - pushing a change of infra/openclaw/workspace/ to the server
  - adding or removing a workspace file
---

# Update the Workspace Files

**Operator.** `infra/openclaw/workspace/` is the source of truth; the live copies under `~/.openclaw/workspace/` are immutable ([06](../installations/06-security-hardening.md)), so the developer proposes changes and the operator applies them. `apply-workspace.sh` is backup + overwrite.

Layout: repository → `~/seed/workspace/` (snapshot) → `~/.openclaw/workspace/` (live). Backups under `~/backups/workspace-backups/<stamp>/`.

`HEARTBEAT.md` is comment-only on purpose — [heartbeat](../gotchas.md#heartbeat-cost-is-a-main-session-problem). Keep it that way.

## Procedure

Diff the repository against the live files. The live files are locked, so the diff shows the edit being pushed and nothing else; anything else is drift worth a question to the user.

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}}
for f in infra/openclaw/workspace/*.md; do
  echo "=== $f"
  sudo diff -u "$f" "/home/{{SERVICE_USER}}/.openclaw/workspace/$(basename "$f")" || true
done
```

Commit and push, so the repository mirrors the server:

```sh
git add infra/openclaw/workspace/ && git commit -m "docs: update workspace files" && git push
```

Apply through the maintenance wrapper. It contains the developer, refreshes the seed snapshot, and restores the workspace ownership, modes and flags through an `EXIT` trap:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance workspace -- \
  /home/{{SERVICE_USER}}/seed/bin/apply-workspace.sh
```

The wrapper leaves the gateway stopped. Start it only after the wrapper reports that hardening was restored and exits 0:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Adding or removing a file

The script mirrors `*.md`, `*.png` and `*.svg` under `~/seed/workspace/`, subdirectories included. The maintenance wrapper discovers the resulting live files and restores their flags dynamically. A removal leaves the live copy in place: delete it through a maintenance window.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance workspace -- \
  rm /home/{{SERVICE_USER}}/.openclaw/workspace/<file>.md
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

`AGENTS.md` cannot be removed: OpenClaw recreates a missing one from its own template, unlocked. Retire its content by shipping the file empty.
