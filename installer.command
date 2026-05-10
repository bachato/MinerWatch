#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# installer.command — macOS one-click installer for MinerWatch.
#
# Double-clicking this file in Finder opens Terminal, deploys MinerWatch
# to ~/Library/Application Support/MinerWatch/, registers the LaunchAgent,
# starts the service, and opens the dashboard in your default browser.
#
# The runtime location is fixed because macOS Privacy (TCC) blocks
# background launchd jobs from reading Desktop / Documents / Downloads /
# iCloud Drive. By installing the running copy under
# ~/Library/Application Support, the LaunchAgent works regardless of
# where the user keeps the source folder.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$HOME/Library/Application Support/MinerWatch"

if [[ -t 1 ]]; then
    BOLD=$(tput bold); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RESET=$(tput sgr0)
else
    BOLD=""; GREEN=""; YELLOW=""; RESET=""
fi

cat <<EOF
${BOLD}MinerWatch installer${RESET}
─────────────────────────────────────

This will:
  1. Copy MinerWatch into:
       ${RUNTIME_DIR}
  2. Create a Python virtual environment in that folder
  3. Install dependencies from requirements.txt
  4. Register MinerWatch as a macOS LaunchAgent (auto-start at login)
  5. Open the dashboard in your browser

Source folder (just for the copy):
  ${SOURCE_DIR}

The service runs from the runtime location, so privacy restrictions on
Desktop / Documents / Downloads / iCloud Drive can't break auto-start.

Press Enter to continue, or Ctrl-C to cancel.
EOF
read -r _

if ! command -v python3 >/dev/null 2>&1; then
    echo "${YELLOW}python3 not found. Install it from https://www.python.org/downloads/${RESET}"
    exit 1
fi

# 1. Deploy: rsync source -> runtime, excluding dev artifacts.
echo
echo "${BOLD}→ Deploying MinerWatch to runtime directory...${RESET}"
mkdir -p "$RUNTIME_DIR"
rsync -a --delete \
    --exclude='.venv/' \
    --exclude='data/' \
    --exclude='__pycache__/' \
    --exclude='.git/' \
    --exclude='.gitignore' \
    --exclude='.DS_Store' \
    --exclude='*.pyc' \
    --exclude='HANDOFF.md' \
    --exclude='reports/' \
    "$SOURCE_DIR/" "$RUNTIME_DIR/"

# Strip macOS quarantine flag in case the source came from a download
# or was moved across TCC boundaries.
xattr -dr com.apple.quarantine "$RUNTIME_DIR" 2>/dev/null || true
chmod +x "$RUNTIME_DIR/start.sh" "$RUNTIME_DIR/stop.sh" \
         "$RUNTIME_DIR/installer.command" "$RUNTIME_DIR/uninstaller.command" \
         "$RUNTIME_DIR/scripts/install-service.sh" \
         "$RUNTIME_DIR/scripts/uninstall-service.sh" 2>/dev/null || true
echo "${GREEN}✓ Files synced${RESET}"

# 2-3. venv + deps in the runtime dir.
cd "$RUNTIME_DIR"

echo
echo "${BOLD}→ Setting up Python virtual environment...${RESET}"
if [[ ! -d .venv ]]; then
    python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "${GREEN}✓ Virtual environment ready${RESET}"

# 4. install service from the runtime dir
echo
echo "${BOLD}→ Registering LaunchAgent...${RESET}"
./scripts/install-service.sh

# 5. open browser
PORT="$(grep -E '^\s*port:' config.example.yaml 2>/dev/null | head -1 | awk '{print $2}')"
PORT="${PORT:-8000}"
URL="http://localhost:$PORT"

echo
echo "${BOLD}→ Opening $URL${RESET}"
open "$URL" || true

cat <<EOF

${GREEN}${BOLD}All done!${RESET}

MinerWatch is installed in:
  ${RUNTIME_DIR}

It will start automatically every time you log in. You can move or
delete the source folder; the service will keep working.

To stop or remove the service, double-click ${BOLD}uninstaller.command${RESET}.

Press Enter to close this window.
EOF
read -r _
