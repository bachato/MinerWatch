#!/usr/bin/env bash
# MinerWatch launcher
# Creates/reuses a venv, installs dependencies, and launches uvicorn.
set -e

cd "$(dirname "$0")"

VENV_DIR=".venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "[MinerWatch] Using Python: $($PYTHON_BIN --version 2>&1) ($(command -v $PYTHON_BIN))"

# If the venv exists but is broken (missing activate), recreate it from scratch.
if [ -d "$VENV_DIR" ] && [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[MinerWatch] Existing venv is incomplete, recreating it."
    rm -rf "$VENV_DIR"
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "[MinerWatch] Creating virtualenv in $VENV_DIR ..."
    if ! "$PYTHON_BIN" -m venv "$VENV_DIR"; then
        echo
        echo "ERROR: '$PYTHON_BIN -m venv' failed."
        echo
        echo "On macOS, Apple's bundled Python sometimes has issues with the venv module."
        echo "Workarounds:"
        echo "  1. Install Python via Homebrew:    brew install python"
        echo "     then re-run with:                PYTHON_BIN=python3 ./start.sh"
        echo "  2. Or use pip --user directly:"
        echo "     pip3 install --user --break-system-packages -r requirements.txt"
        echo "     python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000"
        exit 1
    fi
    if [ ! -f "$VENV_DIR/bin/activate" ]; then
        echo "ERROR: venv was created but activate is missing. ensurepip is probably broken."
        echo "Try: brew install python   and then re-run."
        exit 1
    fi
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "[MinerWatch] Upgrading pip and installing dependencies ..."
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

# Data folder
mkdir -p data

HOST="${MINERWATCH_HOST:-0.0.0.0}"
PORT="${MINERWATCH_PORT:-8000}"

# Host LAN addresses, to print convenient URLs.
LAN_IPS=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}' | head -3)

echo
echo "============================================"
echo "  MinerWatch listening on $HOST:$PORT"
echo "  Local:  http://localhost:$PORT"
for ip in $LAN_IPS; do
    echo "  LAN:    http://$ip:$PORT"
done
echo "  Press Ctrl+C to stop"
echo "============================================"
echo

exec uvicorn backend.main:app --host "$HOST" --port "$PORT" --reload
