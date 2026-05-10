#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# uninstaller.command — macOS one-click uninstaller for MinerWatch.
# Removes the LaunchAgent, then optionally wipes the runtime directory
# (~/Library/Application Support/MinerWatch).

set -euo pipefail

RUNTIME_DIR="$HOME/Library/Application Support/MinerWatch"
PLIST="$HOME/Library/LaunchAgents/com.imlenti.minerwatch.plist"

if [[ -t 1 ]]; then
    BOLD=$(tput bold); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RESET=$(tput sgr0)
else
    BOLD=""; GREEN=""; YELLOW=""; RESET=""
fi

cat <<EOF
${BOLD}MinerWatch uninstaller${RESET}
─────────────────────────────────────

This will remove the auto-start LaunchAgent so MinerWatch no longer
launches at login.

Runtime dir: ${RUNTIME_DIR}

Press Enter to continue, or Ctrl-C to cancel.
EOF
read -r _

# Remove the LaunchAgent. Prefer the bundled script (idempotent),
# fall back to nuking the plist directly if the runtime dir is gone.
if [[ -x "$RUNTIME_DIR/scripts/uninstall-service.sh" ]]; then
    "$RUNTIME_DIR/scripts/uninstall-service.sh"
else
    if [[ -f "$PLIST" ]]; then
        launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || \
            launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        echo "${GREEN}✓${RESET} LaunchAgent removed"
    else
        echo "${YELLOW}!${RESET} No LaunchAgent found (already uninstalled?)"
    fi
fi

# Optionally wipe the runtime directory (database, logs, venv).
if [[ -d "$RUNTIME_DIR" ]]; then
    echo
    echo "${BOLD}Also delete the runtime directory and ALL its data?${RESET}"
    echo "  ${RUNTIME_DIR}"
    echo "  (this erases the database, logs, and the Python venv)"
    printf "Type 'y' to delete, anything else to keep it: "
    read -r ans
    case "$ans" in
        [Yy]|[Yy][Ee][Ss])
            rm -rf "$RUNTIME_DIR"
            echo "${GREEN}✓${RESET} Runtime directory removed"
            ;;
        *)
            echo "${YELLOW}!${RESET} Runtime kept at $RUNTIME_DIR"
            ;;
    esac
fi

echo
echo "${GREEN}${BOLD}Done.${RESET} Press Enter to close this window."
read -r _
