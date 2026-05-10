#!/usr/bin/env bash
# Diagnostics to figure out why start.sh can't create the venv.
# Run with:  ./diagnose.sh

cd "$(dirname "$0")"

echo "=== System ==="
uname -a
sw_vers 2>/dev/null
echo

echo "=== Available Python interpreters ==="
for cmd in python3 python python3.10 python3.11 python3.12 python3.13; do
    if command -v "$cmd" >/dev/null 2>&1; then
        echo "  $cmd  ->  $(command -v $cmd)  ($($cmd --version 2>&1))"
    fi
done
echo

echo "=== which python3 ==="
which python3
echo

echo "=== venv test ==="
TEST_DIR=$(mktemp -d)
echo "Trying: python3 -m venv $TEST_DIR/venv ..."
if python3 -m venv "$TEST_DIR/venv" 2>&1; then
    if [ -f "$TEST_DIR/venv/bin/activate" ]; then
        echo "  OK: venv created successfully."
    else
        echo "  PROBLEM: venv created but 'activate' is missing."
        ls -la "$TEST_DIR/venv/bin" 2>/dev/null
    fi
else
    echo "  FAILED: 'python3 -m venv' returned an error."
fi
rm -rf "$TEST_DIR"
echo

echo "=== Current .venv directory state (if any) ==="
if [ -d ".venv" ]; then
    ls -la .venv
    if [ -d ".venv/bin" ]; then
        echo "  .venv/bin contents:"
        ls -la .venv/bin
    fi
else
    echo "  .venv does not exist (this is normal if you've never run start.sh)"
fi
echo

echo "=== pip ==="
which pip3 2>/dev/null && pip3 --version 2>&1
echo

echo "=== Hint ==="
if ! command -v brew >/dev/null 2>&1; then
    echo "  Homebrew not installed. To install it:"
    echo "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    echo "  then:"
    echo "    brew install python"
elif ! brew list python 2>/dev/null | grep -q .; then
    echo "  You have brew but the python package is missing. Install with:"
    echo "    brew install python"
else
    echo "  You have brew + python. If 'python3 -m venv' still fails,"
    echo "  try forcing the brew python via PYTHON_BIN:"
    BREW_PY="$(brew --prefix)/bin/python3"
    echo "    PYTHON_BIN=$BREW_PY ./start.sh"
fi
