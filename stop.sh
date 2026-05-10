#!/usr/bin/env bash
# Stop the uvicorn process launched by start.sh (handy if it runs in background)
PIDS=$(pgrep -f "uvicorn backend.main:app" || true)
if [ -z "$PIDS" ]; then
    echo "No MinerWatch instance is running."
    exit 0
fi
echo "Stopping PID: $PIDS"
kill $PIDS
