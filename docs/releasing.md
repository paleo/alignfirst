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
5. `verify` installs the freshly published versions in an empty directory, runs `npm audit signatures`, then asserts that each version carries a provenance attestation.

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
npm trust list @paleo/docmap
npm trust revoke @paleo/docmap
```

Renaming the workflow file or the environment breaks every binding; re-register them with the command below.

## Owner setup (one-time)

Done on 2026-08-22. Requires the package owner's npm account and repository admin rights; kept here for re-registration and for a fresh repository.

1. Register the trusted publisher for each package, with npm CLI ≥ 11.19 and logged in as the owner. Earlier CLIs omit the `permissions` field the registry now requires and fail with `400 Bad Request`:

   ```bash
   for pkg in @paleo/alcode @paleo/docmap @paleo/openclaw-channel-mock-core \
              @paleo/openclaw-discord-mock @paleo/openclaw-slack-mock \
              @paleo/openclaw-test @paleo/plans-share @paleo/workspace; do
     npm trust github "$pkg" --repo paleo/alignfirst --file release.yml --env release --allow-publish
   done
   npm trust list @paleo/docmap   # spot-check
   ```

2. Create the `release` environment with a required reviewer and deployments restricted to `main`. Self-review stays allowed, so the owner approves their own releases:

   ```bash
   gh api -X PUT repos/paleo/alignfirst/environments/release --input - <<'JSON'
   {
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true },
     "reviewers": [{ "type": "User", "id": 5991775 }]
   }
   JSON
   gh api -X POST repos/paleo/alignfirst/environments/release/deployment-branch-policies -f name=main
   ```

3. Enable **Allow GitHub Actions to create and approve pull requests** in Settings → Actions → General → Workflow permissions. The `version` job needs it to open the Version Packages PR with the default `GITHUB_TOKEN`.

## Two-factor authentication and tokens

Every package requires 2FA and disallows tokens, applied on 2026-08-22. This closes the token path; the OIDC flow is unaffected, because trusted publishing satisfies the 2FA requirement.

Applied per package with:

```bash
npm access set mfa=publish "@paleo/docmap"
```

In the npmjs.com UI, `publish` is the option "Require two-factor authentication and disallow bypass 2fa tokens (recommended)". The alternative, `automation`, is "Require two-factor authentication or a granular access token with bypass 2fa enabled".

The command prints nothing on success, and the setting cannot be read back — `GET /-/package/<pkg>/access` returns `405`. To check it, use Settings → Publishing access on npmjs.com.
