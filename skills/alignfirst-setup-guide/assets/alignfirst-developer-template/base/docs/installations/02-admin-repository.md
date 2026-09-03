---
title: Admin Repository on the Server
read_when:
  - cloning this repository into the admin account
  - rotating or revoking the deploy key
---

# Admin Repository on the Server

**Operator**, after [01-server-setup.md](01-server-setup.md). The repository is cloned under `{{SERVER_ADMIN_USER}}` so the operator edits and pushes from the server. Authentication uses a deploy key with write access: no human account is trusted on a server that also runs the developer. The repository itself is published from the operator's machine before this step (the setup skill's reference covers rendering and publishing).

## Deploy key

No passphrase: the key is used by unattended sessions.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/{{SERVER_HOST}}_admin_deploy -C "{{SERVER_HOST}}-admin-deploy" -N ""
cat ~/.ssh/{{SERVER_HOST}}_admin_deploy.pub
```

> **User action required.** Add the printed public key as a deploy key of `{{ADMIN_REPOSITORY_URL}}` on the git host, with write access (GitHub: Settings → Deploy keys → Allow write access; GitLab: Settings → Repository → Deploy keys → Grant write permissions).

## SSH alias and clone

The alias binds the key to the git host. `<git-host>` is the host part of `{{ADMIN_REPOSITORY_URL}}`, `<repository-path>` its path part (`owner/name.git`):

```sh
cat >> ~/.ssh/config <<'CONF'

Host {{SERVER_HOST}}-admin
  HostName <git-host>
  User git
  IdentityFile ~/.ssh/{{SERVER_HOST}}_admin_deploy
  IdentitiesOnly yes
CONF
chmod 600 ~/.ssh/config

git config --global user.name "<name>"
git config --global user.email "<email>"

git clone git@{{SERVER_HOST}}-admin:<repository-path> ~/{{ADMIN_REPOSITORY_NAME}}
cd ~/{{ADMIN_REPOSITORY_NAME}}
npm install -g alignfirst
npm install
```

<!-- TEAM_PLANS_SECTION -->
## Team plans repository

`.plans` is a symlink into `~/projects/{{PLANS_CLONE_NAME}}/{{ADMIN_REPOSITORY_NAME}}`. Clone the team plans repository once with the operator's credentials.

> **User action required.** Enable the deploy key on the plans repository too, with write access: `alignfirst sync` pushes. A key enabled read-only clones fine and fails on the first push with `This deploy key does not have write access`.

```sh
mkdir -p ~/projects
git -C ~/projects clone {{PLANS_REPOSITORY_URL}} {{PLANS_CLONE_NAME}}
cd ~/{{ADMIN_REPOSITORY_NAME}}
alignfirst plans setup ~/projects/{{PLANS_CLONE_NAME}}
alignfirst plans check
```
<!-- TEAM_PLANS_SECTION -->

## Workspace and documentation

`mkdir -p .plans` is harmless when `.plans` is already the symlink:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}}
mkdir -p .plans .local
npm run workspace -- setup
alignfirst docmap
```

Continue with [03-toolchain.md](03-toolchain.md).

## Rotate or revoke

Delete the deploy key on the git host, then repeat [Deploy key](#deploy-key); the alias keeps pointing at the regenerated file.

<!-- TEAM_PLANS_SECTION -->
Then enable it again on the plans repository ([Team plans repository](#team-plans-repository)).
<!-- TEAM_PLANS_SECTION -->
