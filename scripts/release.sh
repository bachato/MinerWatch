#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# release.sh — cut a new MinerWatch release in one command.
#
# Usage:
#   ./scripts/release.sh 1.0.3              # interactive (asks before pushing)
#   ./scripts/release.sh 1.0.3 --yes        # no prompt, push immediately
#   ./scripts/release.sh 1.0.3 --dry-run    # show what would happen, don't touch git
#
# What it does:
#   1. Sanity checks: semver-ish version, on main, working tree clean, tag
#      doesn't already exist locally or remotely.
#   2. Bumps VERSION, frontend-react/package.json, frontend-react/package-lock.json
#      to the new version in one atomic commit.
#   3. Creates an annotated tag vX.Y.Z.
#   4. Pushes the commit and the tag (the tag push is what triggers the
#      GitHub Actions release workflow that builds the tarball + checksums
#      and publishes the GitHub Release).
#
# Why this exists: doing the three bumps + commit + tag + two pushes by
# hand every time is error-prone — easy to forget the package-lock or
# typo the tag. The CI release.yml workflow assumes the three version
# files agree, and a mismatch produces a tarball that confuses the
# self-update flow on existing installs.

set -euo pipefail

# ---------- CLI ----------
VERSION="${1:-}"
shift || true
AUTO_YES=false
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y)     AUTO_YES=true ;;
        --dry-run|-n) DRY_RUN=true ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [ -z "$VERSION" ]; then
    cat >&2 <<'EOF'
usage: release.sh <version> [--yes] [--dry-run]
example: release.sh 1.0.3

Options:
  --yes, -y       Skip the confirmation prompt before pushing.
  --dry-run, -n   Show what would be changed without touching git.
EOF
    exit 2
fi

# ---------- locate repo root ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---------- pretty colours (only if stdout is a tty) ----------
if [ -t 1 ]; then
    BOLD=$(tput bold); DIM=$(tput dim); GREEN=$(tput setaf 2)
    YELLOW=$(tput setaf 3); RED=$(tput setaf 1); RESET=$(tput sgr0)
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

die() { echo "${RED}error:${RESET} $*" >&2; exit 1; }
info() { echo "${BOLD}→${RESET} $*"; }
ok()   { echo "${GREEN}✓${RESET} $*"; }
warn() { echo "${YELLOW}!${RESET} $*"; }

# ---------- sanity checks ----------
info "Checking version format…"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
    die "version must look like MAJOR.MINOR.PATCH (got: $VERSION)"
fi
TAG="v$VERSION"
ok "Version is $VERSION → tag will be $TAG"

info "Checking git is available and we're in a repo…"
command -v git >/dev/null 2>&1 || die "git not found in PATH"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
ok "Git ok"

info "Checking the working tree is clean…"
if ! git diff --quiet HEAD --; then
    git status --short
    die "working tree has uncommitted changes — commit or stash them first"
fi
ok "Working tree clean"

info "Checking we're on the main branch…"
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || echo '')"
if [ "$CURRENT_BRANCH" != "main" ]; then
    die "expected to be on 'main', but on '$CURRENT_BRANCH' — release.sh only targets main"
fi
ok "On main"

info "Checking the tag doesn't already exist…"
if git rev-parse "$TAG" >/dev/null 2>&1; then
    die "tag $TAG already exists locally — pick a different version or delete it first (git tag -d $TAG)"
fi
# Refresh remote refs first so we don't push then discover a conflict.
git fetch --tags --quiet origin
if git ls-remote --tags --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1; then
    die "tag $TAG already exists on origin — pick a different version"
fi
ok "Tag $TAG is free"

info "Checking the three version files exist…"
[ -f "VERSION" ] || die "VERSION file missing"
[ -f "frontend-react/package.json" ] || die "frontend-react/package.json missing"
[ -f "frontend-react/package-lock.json" ] || die "frontend-react/package-lock.json missing"
ok "All three present"

# ---------- show diff before bumping ----------
CURRENT_VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
echo
echo "${BOLD}Plan:${RESET}"
echo "  VERSION                          ${DIM}$CURRENT_VERSION${RESET} → ${GREEN}$VERSION${RESET}"
echo "  frontend-react/package.json      ${DIM}^^^${RESET} → ${GREEN}$VERSION${RESET}"
echo "  frontend-react/package-lock.json ${DIM}^^^${RESET} → ${GREEN}$VERSION${RESET}"
echo "  git commit -m 'v$VERSION'"
echo "  git tag -a $TAG -m 'MinerWatch $VERSION'"
echo "  git push origin main"
echo "  git push origin $TAG    ${DIM}# triggers the Release workflow${RESET}"
echo

if $DRY_RUN; then
    warn "Dry-run mode — exiting without touching anything."
    exit 0
fi

if ! $AUTO_YES; then
    read -r -p "Proceed? [y/N] " answer
    case "$answer" in
        y|Y|yes|YES) ;;
        *) die "Aborted by user." ;;
    esac
fi

# ---------- portable in-place sed (BSD on macOS vs GNU on Linux) ----------
# BSD sed needs `-i ''` (empty backup suffix as a separate arg);
# GNU sed accepts `-i` alone but treats the next arg as a script.
if [ "$(uname)" = "Darwin" ]; then
    sed_inplace() { sed -i '' "$@"; }
else
    sed_inplace() { sed -i "$@"; }
fi

# ---------- bump ----------
info "Bumping VERSION…"
echo "$VERSION" > VERSION

info "Bumping frontend-react/package.json…"
sed_inplace "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" frontend-react/package.json

info "Bumping frontend-react/package-lock.json…"
# The lockfile has the version in two places (root + packages.""); the
# /g flag updates both. We deliberately don't run `npm install` here
# because it can churn unrelated metadata; we only touch the project's
# own version, never sub-dependencies.
sed_inplace "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$VERSION\"/g" frontend-react/package-lock.json

# ---------- commit ----------
info "Committing the bump…"
git add VERSION frontend-react/package.json frontend-react/package-lock.json
git commit -m "v$VERSION"

# ---------- tag ----------
# Note on the ${TAG}… braces: macOS ships bash 3.2 with a default
# LC_CTYPE that treats multi-byte UTF-8 leading bytes (here the U+2026
# ellipsis, 0xE2 0x80 0xA6) as identifier continuation, so bare
# ``$TAG…`` is parsed as a variable named ``TAG\xE2…`` and bombs out
# with "TAG?: unbound variable" under ``set -u``. Explicit braces
# delimit the variable name unambiguously.
info "Tagging ${TAG}…"
git tag -a "${TAG}" -m "MinerWatch ${VERSION}"

# ---------- push ----------
info "Pushing main…"
git push origin main

info "Pushing tag ${TAG} (this triggers the Release workflow on GitHub)…"
git push origin "${TAG}"

echo
ok "Released $TAG."
echo "  Watch the build:    https://github.com/imlenti/MinerWatch/actions"
echo "  Release page:       https://github.com/imlenti/MinerWatch/releases/tag/$TAG"
echo
echo "${DIM}When the workflow turns green, existing installations on older"
echo "versions will see the update within 30 minutes (or immediately via"
echo "the 'Check now' button in the Update sidebar entry).${RESET}"
