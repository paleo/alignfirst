---
title: Update the Workspace Files
read_when:
  - pushing a change of infra/openclaw/workspace/ to the server
  - adding or removing a workspace file
---

# Update the Workspace Files

**Operator.** `infra/openclaw/workspace/` is the source of truth; the live copies under `~/.openclaw/workspace/` are immutable ([06](../installations/06-security-hardening.md)), so the developer proposes changes and the operator applies them. `apply-workspace.sh` is backup + overwrite.

Layout: repository → `~/seed/workspace/` (snapshot) → `~/.openclaw/workspace/` (live). Backups under `~/backups/workspace-backups/<stamp>/`.

`HEARTBEAT.md` is comment-only and `TOOLS.md` empty, on purpose — [gotchas.md](../gotchas.md#toolsmd-is-empty-on-purpose), [heartbeat](../gotchas.md#heartbeat-cost-is-a-main-session-problem). Keep them that way.

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

Snapshot, unflag, apply, reflag:

```sh
sudo rsync -a --delete ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/ /home/{{SERVICE_USER}}/seed/
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/seed
sudo chattr -i /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER,TOOLS,HEARTBEAT}.md
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-workspace.sh
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER,TOOLS,HEARTBEAT}.md
```

New sessions read the new files on their own. Restart only when active sessions must see them:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
```

## Adding or removing a file

The script mirrors `*.md`, `*.png` and `*.svg` under `~/seed/workspace/`, subdirectories included. A new file is added to the repository, applied with the procedure above, then added to the two flag lists (here and in `06`). A removal leaves the live copy in place: delete it by hand.

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.openclaw/workspace/<file>.md
sudo -i -u {{SERVICE_USER}} -- rm /home/{{SERVICE_USER}}/.openclaw/workspace/<file>.md
```

`AGENTS.md` and `TOOLS.md` cannot be removed: OpenClaw recreates a missing one from its own template, unlocked. Retire content by shipping the file empty, as `TOOLS.md` is.
