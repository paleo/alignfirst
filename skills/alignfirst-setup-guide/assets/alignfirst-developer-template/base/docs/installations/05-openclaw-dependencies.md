---
title: OpenClaw Tool Dependencies
read_when:
  - installing the OS packages and CLIs the developer's tools need
  - Chromium fails to launch for the service account
---

# OpenClaw Tool Dependencies

**Operator**, after [03-toolchain.md](03-toolchain.md), before the platform part of [07-channel.md](07-channel.md) and [04-openclaw.md](04-openclaw.md). The service account has no sudo, so every OS-level package a tool needs is installed here, with `sudo`. One section per tool group; add a section whenever a new tool is wired up.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

## Playwright (Chromium)

OpenClaw's browser tool uses `playwright-core`. Playwright downloads Chromium into `~/.cache/ms-playwright/`, but Chromium links against shared libraries that come from apt. `playwright install-deps` shells out to `apt-get`, which the service account cannot run, so install them directly (the `t64` suffix is noble's time_t transition):

```sh
sudo apt update && sudo apt install -y \
  libnss3 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libcups2 libdrm2 \
  libxshmfence1 libxfixes3 libatk-bridge2.0-0 libgtk-3-0t64 libvulkan1 \
  fonts-liberation fonts-noto-color-emoji xdg-utils
```

Then download Chromium as the service account:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'npx -y playwright install chromium'
```

When Chromium fails to launch, list the unresolved direct dependencies. GTK and Vulkan load through `dlopen` and do not show here; Playwright's own manifest (`deb.deps` next to the binary) is the cross-check.

```sh
sudo -u {{SERVICE_USER}} ldd /home/{{SERVICE_USER}}/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep "not found"
```

## Images, PDF, OCR, archives

```sh
sudo apt install -y libvips-tools webp librsvg2-bin poppler-utils qpdf \
  tesseract-ocr tesseract-ocr-eng zip unzip p7zip-full xz-utils zstd
```

- `libvips-tools` — `vips`, `vipsthumbnail` (resize, crop, convert); libvips is the engine behind `sharp`, so no second rendering stack.
- `librsvg2-bin` — `rsvg-convert`, SVG to PNG or PDF; also lets `sharp` read SVG.
- `poppler-utils` — `pdftotext`, `pdftoppm` (the OCR feeder), `pdfinfo`, `pdfimages`. `qpdf` merges, splits, rotates, encrypts.
- `tesseract-ocr` — CPU OCR; add languages as `tesseract-ocr-<lang>` (ISO 639-2 codes).
- `p7zip-full` — `7z`, which also extracts some thirty sibling formats.

No ImageMagick (its policy blocks PDFs). PDF generation from HTML goes through Playwright (`page.pdf()`).

## Web development tooling

Already in the base image: `rg`, `jq`, `git`, `curl`, `wget`, `python3`, `ssh`.

```sh
sudo apt install -y build-essential fd-find tree ncdu bat httpie yq sqlite3 postgresql-client \
  pandoc ffmpeg shellcheck shfmt
sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd
sudo ln -sf /usr/bin/batcat /usr/local/bin/bat
```

- `build-essential` — native npm bindings (node-gyp).
- `fd-find`, `bat` — Debian renames the binaries to `fdfind` and `batcat`; the symlinks restore the upstream names.
- `httpie` — `http` and `https`, JSON-aware client.
- `yq` — the Ubuntu package is the Python jq wrapper; sufficient for YAML manifests and compose files.
- `postgresql-client` — `psql` for remote databases; a containerized one is reached with `docker exec`.
- `shellcheck`, `shfmt` — for the shell scripts the developer writes.

## Git-host CLIs

Install the block for each host in `{{GIT_HOSTS}}`, then authenticate.

**GitHub (`gh`)**, from GitHub's apt repository:

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
sudo chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
sudo tee /etc/apt/sources.list.d/github-cli.sources <<EOT
Types: deb
URIs: https://cli.github.com/packages
Suites: stable
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/githubcli-archive-keyring.gpg
EOT
sudo apt update && sudo apt install -y gh
gh --version
```

**GitLab (`glab`)**: no apt repository; install the latest `.deb` from GitLab's releases. Re-run the block to upgrade.

```sh
GLAB_VERSION=$(curl -s "https://gitlab.com/api/v4/projects/34675721/releases" | jq -r '.[0].tag_name | ltrimstr("v")')
ARCH=$(dpkg --print-architecture)
curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb"
sudo dpkg -i /tmp/glab.deb && rm /tmp/glab.deb
glab --version
```

**Authenticate**, as the service account. Pull requests need the CLI logged in on both paths of `03 § 4`; the host CLI path also lets it serve git's HTTPS credentials.

> **User action required.** Each login prints a one-time code and a URL. Open the URL in the laptop browser, logged in as the developer's own account, and approve the code.

```sh
sudo -i -u {{SERVICE_USER}} -- gh auth login --hostname <git-host> --git-protocol ssh --web     # SSH key path
sudo -i -u {{SERVICE_USER}} -- gh auth login --hostname <git-host> --git-protocol https --web   # host CLI path …
sudo -i -u {{SERVICE_USER}} -- gh auth setup-git                                                # … plus git credentials
sudo -i -u {{SERVICE_USER}} -- glab auth login --hostname <git-host>
sudo -i -u {{SERVICE_USER}} -- gh auth status
```

## Context7 (`ctx7`)

Installed in `03` under the npm prefix; rides `@latest` in [update-developer.md](../operations/update-developer.md). The CLI reads `CONTEXT7_API_KEY` from the environment on each call. The seed writes the key from `.env` into `~/.openclaw/.env`, the gateway env file, which the gateway loads at startup and every exec child inherits. `ctx7 login` and `ctx7 setup` are unused: the key is preconfigured, and `setup` would install a duplicate skill and rule.

Verify after `04` has run the seed (a valid key returns results; an invalid one, `Invalid API key`):

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'set -a; . ~/.openclaw/.env; set +a; ctx7 library react "hooks" | head -3'
```

Continue with the platform part of [07-channel.md](07-channel.md), then [04-openclaw.md](04-openclaw.md).
