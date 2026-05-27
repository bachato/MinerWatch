#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Avalon `switchpool` behaviour test (Donate-hashrate groundwork, phase 2a).

This DOES send write commands — but only `switchpool`, and only between
pools the miner ALREADY has configured. It never adds, edits or deletes a
pool, and never changes your payout address. The script auto-detects the
currently-active pool, switches to another EXISTING pool that shares the
same worker/User (so you keep mining to your own address), waits, then
switches back to the original. No admin credentials are used.

What it answers:
  * does `switchpool` work on this firmware, or does it need credentials?
  * does the switch actually take effect (does "Stratum Active" move)?
  * does the Failover strategy bounce it straight back to priority 0?

Usage:
    python3 avalon_write_test.py <miner-ip> [port]

Watch your miner's web UI while it runs if you want a second pair of eyes.
Worst case (a switch sticks and the restore fails) you're left mining to
one of your OWN ckpool slots — same address, zero loss — and you can fix
it from the web UI in one click.
"""
from __future__ import annotations

import json
import socket
import sys
import time


def call(host: str, port: int, command: str, parameter: str | None = None,
         timeout: float = 6.0) -> dict | str:
    req: dict = {"command": command}
    if parameter is not None:
        req["parameter"] = parameter
    payload = json.dumps(req).encode("ascii")
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
    raw = b"".join(chunks).decode("utf-8", "replace").rstrip("\x00\r\n ")
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def status_msg(reply) -> str:
    if isinstance(reply, dict):
        st = reply.get("STATUS")
        if isinstance(st, list) and st:
            return f"{st[0].get('STATUS')}: {st[0].get('Msg')}"
    return str(reply)[:200]


def read_pools(host: str, port: int):
    reply = call(host, port, "pools")
    pools = reply.get("POOLS", []) if isinstance(reply, dict) else []
    rows = []
    for p in pools:
        rows.append({
            "id": p.get("POOL"),
            "url": p.get("URL"),
            "user": p.get("User"),
            "priority": p.get("Priority"),
            "active": p.get("Stratum Active"),
            "status": p.get("Status"),
        })
    return rows


def print_pools(rows) -> None:
    for r in rows:
        flag = "  <== ACTIVE" if r["active"] else ""
        print(f"  POOL {r['id']}  prio={r['priority']}  active={r['active']}  "
              f"{r['url']}  user={r['user']}{flag}")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python3 avalon_write_test.py <miner-ip> [port]")
        return 2
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4028

    print(f"Avalon switchpool test on {host}:{port}\n")
    print("[1] Baseline pools:")
    rows = read_pools(host, port)
    print_pools(rows)

    active = next((r for r in rows if r["active"]), None)
    if active is None:
        print("\nNo active pool detected — aborting (nothing changed).")
        return 1
    orig_id = active["id"]

    # Pick a safe target: a different EXISTING pool with the SAME user
    # (same payout address). Prefer one whose URL mentions ckpool.
    candidates = [r for r in rows if r["id"] != orig_id and r["user"] == active["user"]]
    candidates.sort(key=lambda r: (0 if "ckpool" in (r["url"] or "") else 1, r["id"]))
    if not candidates:
        print("\nNo safe same-address pool to switch to — aborting (nothing changed).")
        print("(That's fine — it just means this miner only has one usable slot.)")
        return 1
    target_id = candidates[0]["id"]

    print(f"\nOriginal active pool = POOL {orig_id}")
    print(f"Will switch to       = POOL {target_id} (same address: {candidates[0]['user']})")
    print(f"Then switch back to  = POOL {orig_id}\n")

    print(f"[2] switchpool {target_id} ...")
    print("   reply:", status_msg(call(host, port, "switchpool", str(target_id))))
    time.sleep(4)
    print("   pools after switch:")
    print_pools(read_pools(host, port))

    print(f"\n[3] switchpool {orig_id} (restore) ...")
    print("   reply:", status_msg(call(host, port, "switchpool", str(orig_id))))
    time.sleep(4)
    print("   pools after restore:")
    after = read_pools(host, port)
    print_pools(after)

    now_active = next((r["id"] for r in after if r["active"]), None)
    print()
    if now_active == orig_id:
        print(f"OK — back on the original POOL {orig_id}.")
    else:
        print(f"NOTE — active pool is now POOL {now_active}, not the original "
              f"{orig_id}. Both are your own address, so no loss; set it back "
              f"from the web UI if you like.")
    print("\nPaste this whole output back into the chat.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
