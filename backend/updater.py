# SPDX-License-Identifier: AGPL-3.0-only
"""Self-update for MinerWatch.

Two halves:

  1. **Read the local version**: a single text file at the repo root
     called ``VERSION`` (just a semver string, e.g. ``0.2.0``). The
     React footer, the ``Update`` page and the FastAPI ``app.version``
     all derive from this one source of truth.

  2. **Talk to GitHub Releases**: hit the public REST endpoint
     ``/repos/<owner>/<repo>/releases/latest``, compare the returned
     ``tag_name`` against the local VERSION, expose ``{current, latest,
     available, ...}`` to the frontend. The response is cached on disk
     for 6 hours so we don't get rate-limited by GitHub (60 req/h/IP
     for anonymous calls — easy to blow through when the dashboard is
     open in several tabs on the LAN).

  3. **Install an update**: download the release tarball, verify its
     SHA256 against the value we pull from ``checksums.txt`` (a
     companion asset built by the release workflow), rsync the
     extracted tree into the runtime directory while preserving the
     user's data, log to ``data/logs/update.log``, then trigger a
     non-zero exit so launchd/systemd relaunch us — at which point
     ``start.sh`` rebuilds the venv if requirements.txt changed.

The whole flow is best-effort and idempotent: any error path leaves
the running version untouched.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import sys
import tarfile
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from .config import DATA_DIR, ROOT_DIR

log = logging.getLogger("minerwatch.updater")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# GitHub repository for releases. If you fork MinerWatch and want the
# update flow to look at *your* fork, change this string (or eventually
# we surface it as a config setting — but for v1 it stays hard-coded
# to upstream so we don't have to defend against malicious overrides
# pointing at a wallet-stealer fork).
GITHUB_OWNER = "imlenti"
GITHUB_REPO = "MinerWatch"
GITHUB_API_BASE = "https://api.github.com"

VERSION_FILE = ROOT_DIR / "VERSION"
CHECK_CACHE_FILE = DATA_DIR / "update_check.json"
UPDATE_LOG_FILE = DATA_DIR / "logs" / "update.log"
STAGING_DIR = ROOT_DIR / ".update-staging"

# Cache duration for the GitHub check, in seconds.
CACHE_TTL_SECONDS = 6 * 3600

# Paths inside ROOT_DIR that we never overwrite during an update —
# these contain user state (DB, push keys, configured miners) and
# build artifacts that must be rebuilt locally (venv).
PRESERVE_PATHS = (
    "data",
    ".venv",
    "config.yaml",
    ".update-staging",
    ".versions",
    "node_modules",  # in case anyone ever installs deps in the runtime dir
)


# ---------------------------------------------------------------------------
# Local version
# ---------------------------------------------------------------------------

def _normalise_version(raw: str) -> str:
    """Strip whitespace and leading ``v`` from a version string.

    ``read_version()`` and the GitHub tag both end up here, so the
    comparison in :func:`check_for_update` doesn't trip on ``v0.3.0``
    vs ``0.3.0``.
    """
    s = (raw or "").strip()
    if s.lower().startswith("v"):
        s = s[1:]
    return s


def read_version() -> str:
    """Return the installed version as a semver string.

    Falls back to ``0.0.0`` if VERSION is missing or unreadable — that
    way the API still responds and the frontend can render *something*
    instead of failing to load the shell.
    """
    try:
        return _normalise_version(VERSION_FILE.read_text(encoding="utf-8"))
    except OSError:
        log.warning("VERSION file unreadable at %s", VERSION_FILE)
        return "0.0.0"


def _semver_tuple(v: str) -> tuple:
    """Cheap semver → tuple for ``>`` comparisons.

    Handles ``MAJOR.MINOR.PATCH`` with optional ``-prerelease`` suffix.
    Anything we can't parse becomes ``(0, 0, 0, "")`` so it sorts below
    a real version (i.e. an "unknown" current version always shows the
    latest release as an update).
    """
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", v.strip())
    if not m:
        return (0, 0, 0, "")
    major, minor, patch, pre = m.groups()
    # Empty prerelease string sorts AFTER any non-empty one, matching
    # semver semantics: 1.0.0 > 1.0.0-rc1.
    return (int(major), int(minor), int(patch), pre or "~")


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

@dataclass
class UpdateCheckResult:
    current: str
    latest: Optional[str]
    available: bool
    release_notes_url: Optional[str] = None
    release_name: Optional[str] = None
    published_at: Optional[str] = None
    asset_url: Optional[str] = None
    asset_name: Optional[str] = None
    asset_size: Optional[int] = None
    sha256: Optional[str] = None
    requires_service_reinstall: bool = False
    error: Optional[str] = None
    checked_at: float = 0.0


def _read_cache() -> Optional[Dict[str, Any]]:
    try:
        raw = CHECK_CACHE_FILE.read_text(encoding="utf-8")
        return json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(payload: Dict[str, Any]) -> None:
    try:
        CHECK_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CHECK_CACHE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as exc:
        log.warning("Failed to write update cache: %s", exc)


def _cache_is_fresh(payload: Dict[str, Any]) -> bool:
    ts = payload.get("checked_at", 0)
    return (time.time() - ts) < CACHE_TTL_SECONDS


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

async def _fetch_latest_release() -> Dict[str, Any]:
    """Hit GitHub Releases API for the latest release of the upstream repo.

    Returns the parsed JSON body on success. Raises ``httpx.HTTPError``
    on network failure and ``RuntimeError`` on 4xx/5xx so the caller
    can produce a sensible error message.
    """
    url = f"{GITHUB_API_BASE}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"MinerWatch/{read_version()}",
        # X-GitHub-Api-Version pin: stable since 2022-11-28, used to
        # avoid drifting onto a future major version that might change
        # the response shape.
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code == 404:
        # No releases published yet for this repo — treat as "no
        # update available" rather than an error.
        raise RuntimeError("no_releases")
    if resp.status_code == 403 and "rate limit" in resp.text.lower():
        raise RuntimeError("rate_limited")
    if resp.status_code >= 400:
        raise RuntimeError(f"github_http_{resp.status_code}")
    return resp.json()


def _pick_asset(release: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Find the tarball asset attached to a Release.

    The release workflow uploads a single ``minerwatch-<version>.tar.gz``
    plus a ``checksums.txt``. We grab the tarball here; the SHA256 is
    pulled separately from ``checksums.txt`` so a single-line corrupt
    asset can't fake its own hash.
    """
    assets = release.get("assets") or []
    for a in assets:
        name = a.get("name", "")
        if name.startswith("minerwatch-") and name.endswith(".tar.gz"):
            return a
    return None


async def _fetch_sha256(release: Dict[str, Any], asset_name: str) -> Optional[str]:
    """Download ``checksums.txt`` from the release assets, look up asset_name."""
    assets = release.get("assets") or []
    checksums_asset = next((a for a in assets if a.get("name") == "checksums.txt"), None)
    if not checksums_asset:
        return None
    url = checksums_asset.get("browser_download_url")
    if not url:
        return None
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.get(url)
    if resp.status_code >= 400:
        return None
    # checksums.txt format: "<hex>  <filename>" per line (shasum -a 256 style)
    for line in resp.text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1] == asset_name:
            return parts[0].lower()
    return None


async def check_for_update(force: bool = False) -> UpdateCheckResult:
    """Return the current/latest version comparison.

    ``force=True`` bypasses the on-disk cache (used by the "Check now"
    button in the UI). Otherwise we return the cached payload if it's
    less than 6 hours old.
    """
    current = read_version()

    if not force:
        cached = _read_cache()
        if cached and _cache_is_fresh(cached):
            cached["current"] = current  # always refresh the local side
            cached["available"] = (
                cached.get("latest") is not None
                and _semver_tuple(cached["latest"]) > _semver_tuple(current)
            )
            return UpdateCheckResult(**{
                k: v for k, v in cached.items()
                if k in UpdateCheckResult.__dataclass_fields__
            })

    try:
        release = await _fetch_latest_release()
    except RuntimeError as exc:
        reason = str(exc)
        result = UpdateCheckResult(
            current=current,
            latest=None,
            available=False,
            error=reason,
            checked_at=time.time(),
        )
        # Cache "no releases" / "rate limited" too — otherwise a spinning
        # frontend would keep hammering the failed call.
        _write_cache(asdict(result))
        return result
    except httpx.HTTPError as exc:
        log.info("Update check network error: %s", exc)
        return UpdateCheckResult(
            current=current,
            latest=None,
            available=False,
            error="network_error",
            checked_at=time.time(),
        )

    latest = _normalise_version(release.get("tag_name") or "")
    asset = _pick_asset(release)
    sha256 = await _fetch_sha256(release, asset["name"]) if asset else None
    requires_reinstall = bool(release.get("body") and "[service-reinstall]" in release["body"])

    result = UpdateCheckResult(
        current=current,
        latest=latest or None,
        available=bool(latest) and _semver_tuple(latest) > _semver_tuple(current),
        release_notes_url=release.get("html_url"),
        release_name=release.get("name") or release.get("tag_name"),
        published_at=release.get("published_at"),
        asset_url=asset.get("browser_download_url") if asset else None,
        asset_name=asset.get("name") if asset else None,
        asset_size=asset.get("size") if asset else None,
        sha256=sha256,
        requires_service_reinstall=requires_reinstall,
        checked_at=time.time(),
    )
    _write_cache(asdict(result))
    return result


# ---------------------------------------------------------------------------
# Install flow
# ---------------------------------------------------------------------------

class UpdateError(RuntimeError):
    """Raised when an install step fails — caught by the API layer and
    surfaced to the frontend as a 500 with a human message."""


def _ensure_log() -> None:
    UPDATE_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def _log_to_file(line: str) -> None:
    _ensure_log()
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with UPDATE_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {line}\n")
    except OSError:
        pass


async def _download(url: str, dest: Path, expected_size: Optional[int]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code >= 400:
                raise UpdateError(f"download HTTP {resp.status_code}")
            with dest.open("wb") as fh:
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    fh.write(chunk)
    if expected_size and dest.stat().st_size != expected_size:
        raise UpdateError(
            f"download size mismatch: expected {expected_size}, got {dest.stat().st_size}",
        )


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    """Extract a tarball, refusing any member that would escape ``dest``.

    Defense against tar-slip: a malicious release could include
    ``../../../../etc/passwd`` as a member path. We resolve every member
    and reject anything outside the staging dir.
    """
    dest = dest.resolve()
    for member in tar.getmembers():
        target = (dest / member.name).resolve()
        if not str(target).startswith(str(dest) + os.sep) and target != dest:
            raise UpdateError(f"unsafe path in tarball: {member.name}")
    tar.extractall(dest)


def _find_extracted_root(staging: Path) -> Path:
    """Some tarballs wrap their contents in a top-level dir (typical
    of GitHub-generated tarballs: ``minerwatch-0.3.0/...``). Find the
    real root by looking for ``backend/`` and ``frontend-react/``.
    """
    candidates = [staging] + [p for p in staging.iterdir() if p.is_dir()]
    for c in candidates:
        if (c / "backend").is_dir() and (c / "VERSION").exists():
            return c
    raise UpdateError("extracted tarball doesn't look like a MinerWatch release")


def _rsync_swap(src: Path, dst: Path) -> None:
    """Copy ``src/*`` into ``dst/`` skipping :data:`PRESERVE_PATHS`.

    We don't use rsync the binary because we can't assume it's
    installed on every Linux. Instead, walk ``src`` ourselves: for
    each file, mkdir parents in dst, then atomic-rename a temp file
    into place.
    """
    preserve = {p.strip("/").split("/", 1)[0] for p in PRESERVE_PATHS}

    for src_root, dirs, files in os.walk(src):
        # Don't descend into preserved top-level dirs that might be
        # *inside* the tarball by accident (shouldn't, but defensive).
        rel_root = Path(src_root).relative_to(src)
        if rel_root.parts and rel_root.parts[0] in preserve:
            dirs[:] = []
            continue

        for d in list(dirs):
            rel = rel_root / d
            if rel.parts[0] in preserve:
                dirs.remove(d)
                continue
            (dst / rel).mkdir(parents=True, exist_ok=True)

        for fname in files:
            rel = rel_root / fname
            if rel.parts and rel.parts[0] in preserve:
                continue
            src_file = Path(src_root) / fname
            dst_file = dst / rel
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            # Write to a tempfile in the same dir, then rename — gives
            # us atomicity on POSIX and avoids half-written files if
            # the process dies mid-write.
            tmp = dst_file.with_suffix(dst_file.suffix + ".upd-tmp")
            shutil.copy2(src_file, tmp)
            os.replace(tmp, dst_file)


async def _install_requirements(reqs_file: Path) -> bool:
    """Install ``requirements.txt`` into the running interpreter's environment.

    Used by the self-update flow when dependencies change, so a new dep (e.g.
    ``aiomqtt``) is present even if the relaunch is a uvicorn ``--reload``
    worker respawn that never re-runs ``start.sh``. Best-effort: returns
    ``True`` on success, ``False`` (logged) on any failure — the caller still
    restarts and ``start.sh`` retries pip on relaunch.
    """
    _log_to_file("requirements.txt changed — installing dependencies…")
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "-r", str(reqs_file),
            cwd=str(ROOT_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        for line in (out or b"").decode("utf-8", "replace").splitlines()[-10:]:
            _log_to_file(f"  pip: {line}")
        if proc.returncode != 0:
            _log_to_file(f"Dependency install FAILED (pip exit {proc.returncode})")
            return False
        _log_to_file("Dependencies installed")
        return True
    except Exception as exc:  # noqa: BLE001
        _log_to_file(f"Dependency install error: {exc}")
        return False


async def install_update() -> Dict[str, Any]:
    """Full install flow. Raises :class:`UpdateError` on any step.

    On success, returns a dict with the new version and schedules a process
    exit (delayed 1.5s so the API response can flush to the frontend). If
    requirements.txt changed, we install the new deps in *this* process first
    so a uvicorn ``--reload`` worker respawn still has them; launchd/systemd
    then relaunch us via ``start.sh``, which also reruns ``pip install`` as a
    backstop.
    """
    _ensure_log()
    _log_to_file("=" * 60)
    _log_to_file(f"Update started from version {read_version()}")

    # 1. Re-check (don't trust a stale cache for the install itself).
    info = await check_for_update(force=True)
    if not info.available:
        _log_to_file(f"No update available (current={info.current}, latest={info.latest}, error={info.error})")
        raise UpdateError("no update available")
    if not info.asset_url:
        _log_to_file("Release has no tarball asset")
        raise UpdateError("release has no installable asset")
    if not info.sha256:
        _log_to_file("Release has no checksum")
        raise UpdateError("release has no checksum — refusing to install")

    _log_to_file(f"Installing {info.latest} from {info.asset_url}")

    # 2. Clean staging dir.
    if STAGING_DIR.exists():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
    STAGING_DIR.mkdir(parents=True, exist_ok=True)

    tarball = STAGING_DIR / (info.asset_name or "release.tar.gz")

    # 3. Download.
    _log_to_file(f"Downloading {info.asset_size} bytes…")
    await _download(info.asset_url, tarball, info.asset_size)

    # 4. Verify SHA256.
    actual = _sha256_file(tarball)
    if actual.lower() != info.sha256.lower():
        _log_to_file(f"SHA256 mismatch: expected {info.sha256}, got {actual}")
        raise UpdateError(
            f"SHA256 mismatch (expected {info.sha256[:12]}…, got {actual[:12]}…)",
        )
    _log_to_file(f"SHA256 ok ({actual[:16]}…)")

    # 5. Extract.
    extract_dir = STAGING_DIR / "extracted"
    if extract_dir.exists():
        shutil.rmtree(extract_dir, ignore_errors=True)
    extract_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tarball, "r:gz") as tar:
        _safe_extract(tar, extract_dir)
    src_root = _find_extracted_root(extract_dir)
    _log_to_file(f"Extracted to {src_root}")

    # 6. Swap files into the runtime dir, preserving user state. Capture the
    # requirements hash first so we can detect a dependency change post-swap.
    reqs_file = ROOT_DIR / "requirements.txt"
    old_reqs_hash = _sha256_file(reqs_file) if reqs_file.exists() else ""
    _rsync_swap(src_root, ROOT_DIR)
    _log_to_file("File swap complete")

    # 6c. If requirements.txt changed, install the new deps NOW into the venv
    # we're running under, so they're present even when the relaunch is a
    # uvicorn --reload worker respawn that never re-runs start.sh's pip step.
    # Best-effort: a failure is logged + flagged; start.sh retries on relaunch.
    deps_changed = False
    deps_ok = True
    if reqs_file.exists() and _sha256_file(reqs_file) != old_reqs_hash:
        deps_changed = True
        deps_ok = await _install_requirements(reqs_file)

    # 6b. Stamp the new dist/ with the installed version. The frontend
    # auto-heal in start.sh keys off this file: if missing or
    # mismatched it re-downloads the tarball at next boot. After a
    # successful self-update the stamp is already correct (the swap
    # brought in the new dist/), so we just write the version to
    # avoid an avoidable round-trip to GitHub on the next launch.
    try:
        stamp = ROOT_DIR / "frontend-react" / "dist" / ".built-version"
        if stamp.parent.exists():
            stamp.write_text(f"{read_version()}\n", encoding="utf-8")
            _log_to_file(f"Stamped {stamp.name} = {read_version()}")
    except OSError as exc:
        _log_to_file(f"Could not stamp .built-version: {exc}")

    # 7. Clean staging to keep disk tidy on the rig.
    shutil.rmtree(STAGING_DIR, ignore_errors=True)

    new_version = read_version()
    _log_to_file(f"Now at version {new_version} — scheduling restart")

    # 8. Trigger restart. On macOS launchd, KeepAlive only relaunches
    # us on a non-zero exit (SuccessfulExit=false in the plist). On
    # Linux systemd, Restart=on-failure has the same constraint. Hence
    # os._exit(1) rather than sys.exit(0).
    asyncio.create_task(_delayed_restart())

    return {
        "status": "restarting",
        "previous_version": info.current,
        "new_version": new_version,
        "requires_service_reinstall": info.requires_service_reinstall,
        "dependencies_updated": deps_changed and deps_ok,
        "dependencies_warning": deps_changed and not deps_ok,
    }


async def _delayed_restart(delay_seconds: float = 1.5) -> None:
    await asyncio.sleep(delay_seconds)
    log.warning("MinerWatch: exiting for self-update restart")
    _log_to_file("Calling os._exit(1) to trigger service-manager relaunch")
    # _exit (not sys.exit) skips atexit / asyncio teardown so we get
    # out of the process cleanly without uvicorn trying to gracefully
    # finish requests that are no longer relevant.
    os._exit(1)


# ---------------------------------------------------------------------------
# System info (used by the Update page to show OS context)
# ---------------------------------------------------------------------------

def system_summary() -> Dict[str, str]:
    return {
        "os": platform.system(),  # Darwin | Linux | Windows
        "os_release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
    }


def in_container() -> bool:
    """Return True when MinerWatch runs inside a container image.

    Why this matters: the self-update flow (download tarball → swap files in
    ``ROOT_DIR`` → ``os._exit(1)``) depends on a service manager
    (launchd/systemd) relaunching the process **and** on a writable,
    persistent filesystem. Inside a container neither holds — the file swap
    lands in the ephemeral writable layer and is discarded the next time the
    image is recreated. So the API layer uses this to refuse the install
    endpoint and steer the user to ``docker compose pull`` instead.

    Detection is deliberately conservative so a bare-metal macOS/Linux install
    is **never** misclassified (which would disable a working feature):

      1. The authoritative signal is the explicit ``MINERWATCH_CONTAINER`` env
         var, which our Dockerfile sets to ``1``. An explicit ``0``/``false``
         forces "not a container" (lets a power user override).
      2. Only when that env var is absent do we fall back to the presence of
         the ``/.dockerenv`` sentinel file. On bare-metal that file does not
         exist, so the fallback returns False and the self-update path is
         left exactly as it is today.
    """
    val = os.environ.get("MINERWATCH_CONTAINER", "").strip().lower()
    if val in {"1", "true", "yes", "on"}:
        return True
    if val in {"0", "false", "no", "off"}:
        return False
    return os.path.exists("/.dockerenv")
