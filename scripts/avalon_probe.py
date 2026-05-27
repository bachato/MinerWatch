#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Avalon / Canaan read-only API probe (Donate-hashrate groundwork).

Dumps the raw cgminer-API replies we need to design pool switching for
Avalon miners (Nano 3s / Avalon Q / Avalon Mini 3).

READ-ONLY AND SAFE: it sends only query commands. It issues NO `ascset`,
NO `setpool`, NO write of any kind — it cannot change where your miner
mines, and it needs no admin credentials.

Usage:
    python3 avalon_probe.py <miner-ip> [port]

Example:
    python3 avalon_probe.py 192.168.1.50

Then paste the output back. You can redact your IP / worker name if you
want — the JSON *structure* is what matters, not the values.
"""
from __future__ import annotations

import json
import socket
import sys

# Read-only commands only. If you don't see one of these in the output,
# the firmware just doesn't support it — that's useful information too.
COMMANDS = ("version", "summary", "pools", "config", "devdetails", "estats")


def call(host: str, port: int, command: str, timeout: float = 6.0) -> str:
    """Open a short TCP connection, send one cgminer JSON command, read
    until the miner closes the socket (or we time out), return raw text."""
    payload = json.dumps({"command": command}).encode("ascii")
    chunks: list[bytes] = []
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(payload)
        s.settimeout(timeout)
        while True:
            try:
                b = s.recv(4096)
            except socket.timeout:
                break
            if not b:
                break
            chunks.append(b)
    return b"".join(chunks).decode("utf-8", "replace").rstrip("\x00\r\n ")


def show(host: str, port: int, command: str) -> None:
    print("=" * 72)
    print(f"$ {command}")
    print("-" * 72)
    try:
        raw = call(host, port, command)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}")
        return
    if not raw:
        print("(empty reply)")
        return
    try:
        parsed = json.loads(raw)
        print(json.dumps(parsed, indent=2)[:8000])
    except ValueError:
        # Legacy pipe-delimited Avalon dialect — print as-is.
        print(raw[:8000])


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python3 avalon_probe.py <miner-ip> [port]")
        return 2
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4028
    print(f"Probing Avalon API at {host}:{port}  (READ-ONLY — nothing is changed)\n")
    for cmd in COMMANDS:
        show(host, port, cmd)
    print()
    print("=" * 72)
    print("Done. No write/ascset/setpool commands were sent — the miner is untouched.")
    print("Paste the output above back into the chat.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
