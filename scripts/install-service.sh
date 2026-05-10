#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# install-service.sh — register MinerWatch as an auto-starting service.
#
# macOS  → installs a user-level launchd LaunchAgent.
# Linux  → installs a user-level systemd unit.
#
# After installation:
#   * MinerWatch starts automatically at login (or boot, on Linux with
#     loginctl enable-linger).
#   * If the process crashes it is restarted automatically.
#   * Logs are written to data/logs/minerwatch.{out,err}.log on macOS,
#     and to journald on Linux (run `journalctl --user -u minerwatch -f`).
#
# Usage:
#   ./scripts/install-service.sh           # install + start
#   ./scripts/install-service.sh --status  # show current state
#   ./scripts/uninstall-service.sh         # remove the service
#
# Idempotent: re-running re-installs cleanly.

set -euo pipefail

# -- Resolve repo root regardless of where the script is invoked from -------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.imlenti.minerwatch"

# -- Pretty output helpers --------------------------------------------------
if [[ -t 1 ]]; then
    BOLD=$(tput bold); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
    RED=$(tput setaf 1); BLUE=$(tput setaf 4); RESET=$(tput sgr0)
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; BLUE=""; RESET=""
fi
say()  { printf "%s%s%s\n" "$BLUE" "$1" "$RESET"; }
ok()   { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
die()  { printf "%s✗%s %s\n" "$RED"   "$RESET" "$1" >&2; exit 1; }

# -- Sanity checks ----------------------------------------------------------
[[ -x "$REPO_DIR/start.sh" ]] || die "start.sh not found or not executable in $REPO_DIR"
mkdir -p "$REPO_DIR/data/logs"

OS="$(uname -s)"

# ============================================================================
# macOS (launchd)
# ============================================================================
install_macos() {
    local plist_template="$SCRIPT_DIR/com.imlenti.minerwatch.plist.template"
    local plist_dest="$HOME/Library/LaunchAgents/${LABEL}.plist"

    [[ -f "$plist_template" ]] || die "Template missing: $plist_template"

    say "→ Installing macOS LaunchAgent ($LABEL)"
    mkdir -p "$HOME/Library/LaunchAgents"

    # Substitute placeholders. We use | as sed delimiter because the path
    # likely contains slashes.
    sed \
        -e "s|@MINERWATCH_DIR@|$REPO_DIR|g" \
        -e "s|@LABEL@|$LABEL|g" \
        "$plist_template" > "$plist_dest"
    ok "Wrote $plist_dest"

    # Unload first if already loaded (idempotent).
    if launchctl list | grep -q "$LABEL"; then
        launchctl unload "$plist_dest" >/dev/null 2>&1 || true
        ok "Unloaded previous instance"
    fi

    launchctl load "$plist_dest"
    ok "Loaded service"

    # Wait briefly for the service to come up, then poll the local port.
    say "→ Waiting for backend to start..."
    local port
    port="$(grep -E '^\s*port:' "$REPO_DIR/config.example.yaml" 2>/dev/null \
        | head -1 | awk '{print $2}')"
    port="${port:-8000}"

    local attempt=0
    while (( attempt < 30 )); do
        if curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1 \
           || curl -fsS "http://localhost:$port/" >/dev/null 2>&1; then
            ok "MinerWatch is up at http://localhost:$port"
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    warn "Service is loaded but did not respond on :$port within 30s."
    warn "Check logs: tail -f $REPO_DIR/data/logs/minerwatch.err.log"
}

# ============================================================================
# Linux (systemd --user)
# ============================================================================
install_linux() {
    local unit_template="$SCRIPT_DIR/minerwatch.service.template"
    local unit_dir="$HOME/.config/systemd/user"
    local unit_dest="$unit_dir/minerwatch.service"

    [[ -f "$unit_template" ]] || die "Template missing: $unit_template"
    command -v systemctl >/dev/null 2>&1 || die "systemctl not available; this script targets systemd-based distros."

    say "→ Installing systemd user unit (minerwatch.service)"
    mkdir -p "$unit_dir"
    sed -e "s|@MINERWATCH_DIR@|$REPO_DIR|g" "$unit_template" > "$unit_dest"
    ok "Wrote $unit_dest"

    systemctl --user daemon-reload
    systemctl --user enable --now minerwatch.service
    ok "Enabled and started"

    say "→ Status:"
    systemctl --user --no-pager --lines=5 status minerwatch.service || true

    cat <<EOF

${BOLD}Tip:${RESET} to make MinerWatch start at boot even without an
interactive login (typical on a Raspberry Pi headless setup), run:

    sudo loginctl enable-linger \$USER

Tail logs with:

    journalctl --user -u minerwatch -f

EOF
}

# ============================================================================
# Status / dispatch
# ============================================================================
show_status() {
    case "$OS" in
        Darwin)
            if launchctl list | grep -q "$LABEL"; then
                ok "LaunchAgent $LABEL is loaded."
                launchctl list | grep "$LABEL" | head -1
            else
                warn "LaunchAgent $LABEL is NOT loaded."
            fi
            ;;
        Linux)
            systemctl --user status minerwatch.service --no-pager --lines=10 \
                || warn "Service not installed or not running."
            ;;
        *) die "Unsupported OS: $OS";;
    esac
}

if [[ "${1:-}" == "--status" ]]; then
    show_status
    exit 0
fi

case "$OS" in
    Darwin)  install_macos ;;
    Linux)   install_linux ;;
    *)       die "Unsupported OS: $OS (this script supports macOS and Linux)." ;;
esac

cat <<EOF

${BOLD}${GREEN}Done.${RESET} MinerWatch will now start automatically at login.

Useful commands:
  ./scripts/install-service.sh --status   show current state
  ./scripts/uninstall-service.sh          remove the service
  tail -f data/logs/minerwatch.out.log    follow stdout (macOS)

EOF
