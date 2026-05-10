#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# uninstall-service.sh — remove the MinerWatch auto-start service.
#
# Mirrors install-service.sh: macOS launchd or Linux systemd --user.
# Idempotent: safe to run when nothing is installed.

set -euo pipefail

LABEL="com.imlenti.minerwatch"

if [[ -t 1 ]]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1); RESET=$(tput sgr0)
else
    GREEN=""; YELLOW=""; RED=""; RESET=""
fi
ok()   { printf "%s✓%s %s\n" "$GREEN"  "$RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
die()  { printf "%s✗%s %s\n" "$RED"    "$RESET" "$1" >&2; exit 1; }

OS="$(uname -s)"

case "$OS" in
    Darwin)
        plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
        if [[ -f "$plist" ]]; then
            launchctl unload "$plist" >/dev/null 2>&1 || true
            rm -f "$plist"
            ok "Removed $plist"
        else
            warn "No LaunchAgent found at $plist (already uninstalled?)"
        fi
        ;;
    Linux)
        unit="$HOME/.config/systemd/user/minerwatch.service"
        if [[ -f "$unit" ]]; then
            systemctl --user disable --now minerwatch.service >/dev/null 2>&1 || true
            rm -f "$unit"
            systemctl --user daemon-reload
            ok "Removed $unit"
        else
            warn "No systemd unit found at $unit (already uninstalled?)"
        fi
        ;;
    *)
        die "Unsupported OS: $OS"
        ;;
esac

ok "Uninstall complete."
