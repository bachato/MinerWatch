# MinerWatch - Release & Umbrel update playbook

Single source of truth for shipping a new MinerWatch version and pushing it to
the Umbrel Community App Store. When you type `Update X.Y.Z`, Claude follows
this file step by step.

Hard rule for every commit and push in **both** repos. Author and committer
must always be `imlenti <280957457+imlenti@users.noreply.github.com>`:

    git config user.name imlenti
    git config user.email 280957457+imlenti@users.noreply.github.com

## Repos and paths

- App source: `MinerWatch` -> `/Users/francescocorticchia/MinerWatch` (remote `imlenti/MinerWatch`)
- Community store: `minerwatch-app-store` -> `/Users/francescocorticchia/minerwatch-app-store` (remote `imlenti/minerwatch-app-store`)

The two repos are siblings on disk.

## What CI does for you (no manual packages)

Pushing a tag `vX.Y.Z` to `MinerWatch` triggers two GitHub Actions:

- `release.yml` -> source tarball + `checksums.txt` + the GitHub Release.
- `docker-publish.yml` -> multi-arch image `ghcr.io/imlenti/minerwatch:X.Y.Z` and `:latest`.

The GHCR image is the "package" Umbrel pulls, and it is built automatically by
the tag push. There is no manual package step.

## Version-bearing files

In `MinerWatch`:

- `VERSION` (bumped by `scripts/release.sh`)
- `frontend-react/package.json` and `frontend-react/package-lock.json` (bumped by `scripts/release.sh`)
- `umbrel/umbrel-app.yml` field `version:` and `umbrel/docker-compose.yml` field `image:`
- `community-app-store/imlenti-minerwatch/umbrel-app.yml` field `version:` and its `docker-compose.yml` field `image:`

`community-app-store/imlenti-minerwatch/` is the canonical mirror copied into
the store repo. `umbrel/` (id `minerwatch`) is the copy for a future official
Umbrel submission and is kept in sync too.

In `minerwatch-app-store`:

- `imlenti-minerwatch/umbrel-app.yml` (mirror; `gallery` uses `.png`)
- `imlenti-minerwatch/docker-compose.yml` (mirror)
- `imlenti-minerwatch/1.png 2.png 3.png` (screenshots; change only when screenshots change)

## Fastest path: one command

From the `MinerWatch` repo, on your Mac:

    ./scripts/release-umbrel.sh X.Y.Z

It forces the identity in both repos, runs `scripts/release.sh` (source bump +
tag + image), bumps the Umbrel manifests, waits for you to confirm the image is
published, then mirrors and pushes the store repo. Read it once before trusting it.

## Manual path (comment-free, copy-paste safe, macOS)

No inline comments, no smart quotes, so the CLI will not choke on quoting.

### Block A - source release, tag, image

    cd /Users/francescocorticchia/MinerWatch
    git config user.name imlenti
    git config user.email 280957457+imlenti@users.noreply.github.com
    ./scripts/release.sh X.Y.Z

Then open `https://github.com/imlenti/MinerWatch/actions` and wait until both
workflows are green and `ghcr.io/imlenti/minerwatch:X.Y.Z` exists.

### Block B - bump the Umbrel manifests

    cd /Users/francescocorticchia/MinerWatch
    V=X.Y.Z
    sed -i '' -E "s/^version: .*/version: \"$V\"/" umbrel/umbrel-app.yml community-app-store/imlenti-minerwatch/umbrel-app.yml
    sed -i '' -E "s#^( *image: ghcr.io/imlenti/minerwatch:).*#\\1$V#" umbrel/docker-compose.yml community-app-store/imlenti-minerwatch/docker-compose.yml
    git add umbrel/umbrel-app.yml umbrel/docker-compose.yml community-app-store/imlenti-minerwatch/umbrel-app.yml community-app-store/imlenti-minerwatch/docker-compose.yml
    git commit -m "Umbrel manifests $V"
    git push origin main

### Block C - sync the Community App Store (run after the image is published)

    cd /Users/francescocorticchia/minerwatch-app-store
    V=X.Y.Z
    git config user.name imlenti
    git config user.email 280957457+imlenti@users.noreply.github.com
    cp ../MinerWatch/community-app-store/imlenti-minerwatch/umbrel-app.yml imlenti-minerwatch/umbrel-app.yml
    cp ../MinerWatch/community-app-store/imlenti-minerwatch/docker-compose.yml imlenti-minerwatch/docker-compose.yml
    sed -i '' -E 's#^(  - [0-9]+)\.jpg#\1.png#' imlenti-minerwatch/umbrel-app.yml
    git add imlenti-minerwatch/umbrel-app.yml imlenti-minerwatch/docker-compose.yml
    git commit -m "Update MinerWatch app to $V"
    git push origin main

## Verify after a release

    cd /Users/francescocorticchia/MinerWatch && cat VERSION && git --no-pager log -1 --pretty="%h %an <%ae> %s"
    grep -n "version:\|image:" community-app-store/imlenti-minerwatch/umbrel-app.yml community-app-store/imlenti-minerwatch/docker-compose.yml
    cd /Users/francescocorticchia/minerwatch-app-store && grep -n "version:\|image:\|\.png" imlenti-minerwatch/umbrel-app.yml imlenti-minerwatch/docker-compose.yml && git --no-pager log -1 --pretty="%h %an <%ae> %s"

Store `version:` must equal `VERSION`, the `image:` tag must match, gallery must
list `.png`, and both last commits must show `imlenti <280957457+imlenti@users.noreply.github.com>`.

## Notes

- macOS uses BSD `sed`, hence `sed -i ''`. On Linux drop the `''` (use `sed -i -E`).
- Block C normalizes the gallery to `.png` on every copy, so the store stays correct even if the canonical copy still lists `.jpg`.
- If git was ever run from a sandbox/mounted environment and left `.git/*.lock` files, clear them on your Mac: `rm -f .git/index.lock .git/HEAD.lock .git/objects/maintenance.lock`
