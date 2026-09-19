---
title: Releasing
summary: How the packages reach npm — the Version Packages PR, the approval-gated publish job, and provenance.
read_when:
  - releasing packages to npm
  - verifying the provenance of a published tarball
  - managing the trusted-publisher bindings or the release environment
---

# Releasing

Packages publish from GitHub Actions through npm trusted publishing (OIDC). There is no npm token, and nothing publishes from a developer machine.

## Flow

1. A PR authors a changeset (see [writing-a-changeset.md](writing-a-changeset.md)) and is squash-merged into `main`.
2. `.github/workflows/release.yml` runs on the push. Its `version` job creates or updates the **release: version packages** PR, which applies the pending changesets to the manifests and changelogs.
3. Merging that PR pushes the bumped versions to `main`. The `check` job now finds versions absent from the registry and enables the `publish` job.
4. `publish` is bound to the `release` environment, so it waits for one approval. After approval it builds, tests, strips the `scripts` field from the workspace manifests, and runs `changeset publish`. npm attaches a provenance attestation to each tarball. The action then pushes git tags and creates the GitHub releases.
5. `verify` waits 15 minutes, then installs the freshly published versions in an empty directory, runs `npm audit signatures`, and asserts that each version carries a provenance attestation. The wait is the `verify` environment's timer: npm's CDN keeps serving a stale packument for several minutes after a publish, and a job held by a wait timer occupies no runner.

A push that publishes nothing — a feature merge, a docs-only merge — leaves `check` reporting no pending version, so no approval is ever requested.

## Verifying provenance

In any project that depends on these packages:

```bash
npm audit signatures
```

Each package must report a verified registry signature and a verified attestation. The attestation links the tarball to the `main` commit and the workflow run that built it.

The command reports *invalid* signatures; it exits 0 when a package has no attestation at all. To check that one exists, read it directly:

```bash
npm view <package>@<version> dist.attestations.provenance.predicateType
```

npm attaches provenance only when the repository and the package are both public and no `provenance` config overrides the default. A failure of any of those conditions is logged at verbose level and leaves the publish green, which is what the `verify` job guards against.

## Trusted-publisher bindings

Each package is bound to repository `paleo/alignfirst`, workflow `release.yml`, environment `release`. Inspect or remove a binding as the package owner:

```bash
npm trust list @alignfirst/docmap
npm trust revoke @alignfirst/docmap
```

Renaming the workflow file or the environment breaks every binding; re-register them with the loop in [Adding a package name](#adding-a-package-name).

## Adding a package name

A trusted publisher binds to an existing package, so a name the registry has never seen can neither be registered nor publish from CI. Bootstrap it by hand, from a machine logged in to npm as the owner, on the commit that introduces the name and before that commit reaches `main`.

1. Publish the current version of every unpublished name. `changeset publish` skips the names the registry already serves, so one run covers them all. Restore the manifests afterwards — `npm pkg delete` rewrites them in place:

   ```bash
   npm run clear && npm run build && npm run lint && npm run test
   npm pkg delete scripts --workspaces
   npx changeset publish
   git checkout -- package.json packages/*/package.json
   ```

   These tarballs carry no provenance attestation. Every later version publishes through CI and does.

2. Register the trusted publisher and require 2FA for each name, with npm CLI ≥ 11.19. Earlier CLIs omit the `permissions` field the registry now requires and fail with `400 Bad Request`:

   ```bash
   for pkg in alignfirst @alignfirst/alcode @alignfirst/alproject @alignfirst/docmap \
              @alignfirst/openclaw-channel-mock-core @alignfirst/openclaw-discord-mock \
              @alignfirst/openclaw-slack-mock @alignfirst/openclaw-test \
              @alignfirst/service-openclaw-plugin @alignfirst/workspace; do
     npm trust github "$pkg" --repo paleo/alignfirst --file release.yml --env release --allow-publish
     npm access set mfa=publish "$pkg"
   done
   npm trust list @alignfirst/docmap   # spot-check
   ```

3. When the new name replaces an older one, deprecate the older one so an install of it points at the new:

   ```bash
   npm deprecate @paleo/docmap "Renamed to @alignfirst/docmap"
   ```

Publishing the current versions first preserves the invariant above: `check` reports nothing pending until the **release: version packages** PR lands, and the rename's own release is the first one CI is asked to approve.

## Owner setup (one-time)

Done on 2026-08-22, when the packages carried their `@paleo/*` names; their trusted publishers were registered with the loop above. Requires the package owner's npm account and repository admin rights; kept here for a fresh repository.

1. Create the `release` environment with a required reviewer and deployments restricted to `main`. Self-review stays allowed, so the owner approves their own releases:

   ```bash
   gh api -X PUT repos/paleo/alignfirst/environments/release --input - <<'JSON'
   {
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true },
     "reviewers": [{ "type": "User", "id": 5991775 }]
   }
   JSON
   gh api -X POST repos/paleo/alignfirst/environments/release/deployment-branch-policies -f name=main
   ```

2. Enable **Allow GitHub Actions to create and approve pull requests** in Settings → Actions → General → Workflow permissions. The `version` job needs it to open the Version Packages PR with the default `GITHUB_TOKEN`.

## The `verify` environment

Created on 2026-09-14. Its only purpose is the wait timer, so it carries no reviewer and no branch policy:

```bash
gh api -X PUT repos/paleo/alignfirst/environments/verify -F wait_timer=15
```

Before it existed, `verify` ran the moment `publish` finished and failed on every release: the
registry answered `ETARGET` for the versions just published, for more than five minutes each time.
The job's retry loop never once outlasted the stale packument. Recreate the environment with the
command above if it is ever deleted — the job's first step then waits out the remainder itself, so a
missing timer costs runner minutes rather than a failed release.

## Two-factor authentication and tokens

Every package requires 2FA and disallows tokens. This closes the token path; the OIDC flow is unaffected, because trusted publishing satisfies the 2FA requirement. [Adding a package name](#adding-a-package-name) applies it to each new name:

```bash
npm access set mfa=publish "@alignfirst/docmap"
```

In the npmjs.com UI, `publish` is the option "Require two-factor authentication and disallow bypass 2fa tokens (recommended)". The alternative, `automation`, is "Require two-factor authentication or a granular access token with bypass 2fa enabled".

The command prints nothing on success, and the setting cannot be read back — `GET /-/package/<pkg>/access` returns `405`. To check it, use Settings → Publishing access on npmjs.com.
