---
title: Publishing Preview Versions
summary: Publish an opt-in variant of a stable package without changing npm's latest tag or consuming the next release number.
read_when:
  - publishing a preview from a feature branch
  - choosing a preview version or npm tag
  - installing a preview or returning to the stable release
---

# Publishing Preview Versions

Publish previews interactively from a feature worktree with npm 2FA and an explicit non-`latest` tag. Stable releases continue through [the CI release workflow](releasing.md).

This is the procedure used for the earlier protocol preview. Local previews carry no provenance attestation; publishing one leaves the stable versions and their attestations unchanged. The package policy permits interactive 2FA publishing even though it disallows token-based publishing.

## Version and tag

Use `<baseline>-preview.<topic>.<revision>`, where the baseline is the stable version the preview modifies:

- `0.11.0-preview.topics.0` — first topics preview based on `0.11.0`.
- `0.11.0-preview.topics.1` — another iteration on that baseline.

Use a short lowercase topic and start the revision at zero. Every published version is immutable; increment the revision for each publish. Leave the package's committed version and pending changesets unchanged.

SemVer sorts this version below `0.11.0`. It is an opt-in variant, not the next stable release. Use an exact version or a dist-tag to install it; ordinary stable ranges exclude prereleases.

The npm tag is a separate, movable pointer:

- `preview` — the shared preview channel, matching the previous procedure.
- `preview-topics` — a topic-specific channel when several previews need to coexist.

Publishing with `--tag preview` moves only `preview`. Always pass the tag explicitly; never use `latest` for this procedure.

## Prepare

Run from the repository root on the feature branch. Commit the changes to test first: the worktree must be clean because cleanup restores the manifest and lockfile to `HEAD`.

```bash
git status --short
npm view alignfirst dist-tags --json
npm pkg get version dependencies --workspace alignfirst
```

Check that the branch contains the intended stable baseline and feature changes. If it needs updating, merge or rebase it before testing. Choose the baseline from the code being published, not just the newest registry version.

Every runtime dependency must already be available on npm at a version satisfying the package's declared range. Check internal dependencies explicitly, for example:

```bash
npm view '@alignfirst/docmap@~0.11.2' version
```

If a dependency also needs unreleased changes, stop: publishing that dependency and wiring its preview version requires a coordinated release. The procedure below publishes one package only.

Authenticate as an npm owner with publishing rights and 2FA. Run `npm login` if `whoami` fails or shows the wrong account:

```bash
npm whoami
npm login
```

## Build and publish

Set the four values at the top for the selected package. Run this Bash block from the repository root. It checks and builds before temporarily changing the version, then restores the manifest and lockfile on success or failure.

```bash
(
  set -e
  PACKAGE=alignfirst
  VERSION=0.11.0-preview.topics.0
  TAG=preview
  MANIFEST=packages/alignfirst/package.json

  test -z "$(git status --porcelain)" || {
    echo "Commit or set aside worktree changes first."
    exit 1
  }
  case "$TAG" in
    preview|preview-*) ;;
    *) echo "Use preview or preview-<topic>."; exit 1 ;;
  esac

  LATEST_BEFORE=$(npm view "$PACKAGE@latest" version)
  npm view "$PACKAGE" dist-tags --json

  npm ci
  npm run clear
  npm run build
  npm run lint
  npm test

  trap 'git restore -- "$MANIFEST" package-lock.json' EXIT
  npm version "$VERSION" --no-git-tag-version --ignore-scripts --workspace "$PACKAGE"
  npm pkg delete scripts --workspace "$PACKAGE"
  npm run release:smoke
  npm publish --workspace "$PACKAGE" --tag "$TAG" --dry-run

  # Inspect the package contents above. Publishing may open a browser for 2FA.
  read -r -p "Publish $PACKAGE@$VERSION under $TAG? Type yes: " CONFIRM
  test "$CONFIRM" = yes
  npm publish --workspace "$PACKAGE" --tag "$TAG"

  npm view "$PACKAGE" dist-tags --json
  echo "latest before publish: $LATEST_BEFORE"
)
git status --short
```

The current `release:smoke` checks the alignfirst and docmap tarballs together, not their registry dependency availability. For other packages, also run their package-specific installation checks.

Confirm that the selected tag points to the new version and `latest` is unchanged. Registry metadata can lag for several minutes; retry the lookup before treating a missing version as a failed publish. If another stable release ran concurrently, compare with that release rather than reverting its tag.

If interrupted before cleanup, restore only the temporary files from the initially clean checkout:

```bash
git restore -- packages/alignfirst/package.json package-lock.json
```

Do not run `changeset version`, `changeset pre`, or `changeset publish` for this procedure. The preview version is never committed, so the normal release workflow continues to compare the stable manifests on `main` with npm.

## Test the published package

Use an exact version for reproducible testing. Run outside this monorepo so its workspace binary cannot mask the installed preview:

```bash
npx -y alignfirst@0.11.0-preview.topics.0 --version
npx -y alignfirst@0.11.0-preview.topics.0 guide aad --protocol-only
```

Use `alignfirst@preview` instead to follow the moving channel. For a global installation:

```bash
npm install -g alignfirst@preview
alignfirst --version
```

Install under the Node version used by the coding agent; fnm and nvm have separate global installs per Node version. A project-local dependency can take precedence over a global install when using `npx`. Check `npx -y alignfirst --version` in the actual test project rather than assuming it uses the preview.

**AlignFirst configuration guard:** a configured `cli` range rejects every prerelease version. The current parser accepts only stable versions in ranges, so setting `cli` to the preview version does not work either. Test in a project without `cli`, or temporarily remove that field from the resolved project config and restore it after testing. `alignfirst config --json` reports the resolved configuration even when the guard fails.

Local previews have no provenance attestation. `npm audit signatures` can pass without one; it does not certify CI provenance for this publish.

## End the test

Replace a global preview with the stable release, or uninstall it if testers normally use on-demand `npx`:

```bash
npm install -g alignfirst@latest
# Or: npm uninstall -g alignfirst
```

Restore any project dependency pins and temporary `cli` config changes. A global preview does not update itself when a new stable version is published.

Merge the feature and its changeset through the normal release process. Let CI publish a new stable version; do not promote the preview tarball to `latest`.
