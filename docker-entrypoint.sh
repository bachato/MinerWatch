#!/bin/sh
# MinerWatch container entrypoint.
#
# Why this exists
# ---------------
# The persistent data dir (/app/data) is a bind mount. When Docker has to
# create the bind-mount *source* on the host (a fresh install, or Umbrel's
# ${APP_DATA_DIR}/data that doesn't exist yet) it creates it as root:root.
# The app, however, runs unprivileged as UID/GID 1000. A root-owned dir that
# UID 1000 can't write into is exactly what produced:
#
#     sqlite3.OperationalError: unable to open database file
#
# So we start the container as root, make the data dir writable by the runtime
# user, and only then drop privileges to that user via gosu.
#
# Scope
# -----
# This path is Docker-only. Bare-metal installs launch through start.sh
# (launchd / systemd) and NEVER invoke this script — that flow is unchanged and
# keeps running as the installing user against a repo-local ./data it owns.
set -eu

# The data dir can be relocated for tests/edge hosts; default matches the image.
DATA_DIR="${MINERWATCH_DATA_DIR:-/app/data}"
TARGET_UID=1000
TARGET_GID=1000

if [ "$(id -u)" = "0" ]; then
    # Running as root (the default for this image): guarantee the data dir
    # exists, then make it writable by the runtime user IF it isn't already.
    mkdir -p "$DATA_DIR"

    # Only take ownership when the runtime user genuinely can't write to the
    # data dir. This keeps us from needlessly flipping the ownership of a dir
    # that already works — e.g. one shared with a bare-metal install that owns
    # it — and limits the chown to the actual failure case (a root-owned bind
    # mount). chown can also legitimately fail on exotic mounts (read-only,
    # SMB/CIFS that ignore ownership); we don't crash the container over it.
    if ! gosu "${TARGET_UID}:${TARGET_GID}" sh -c "touch '$DATA_DIR/.mw-write-test' 2>/dev/null && rm -f '$DATA_DIR/.mw-write-test'"; then
        chown -R "${TARGET_UID}:${TARGET_GID}" "$DATA_DIR" 2>/dev/null || true
    fi

    # Drop privileges and hand off to the app. exec keeps the app as PID 1 so
    # it receives SIGTERM from `docker stop` directly and shuts down cleanly.
    exec gosu "${TARGET_UID}:${TARGET_GID}" "$@"
fi

# Already non-root: an operator pinned `user:` in compose, or this is a
# locked-down runtime. We can't chown without root, so just run the app and
# rely on the mount already being writable by the current UID.
exec "$@"
