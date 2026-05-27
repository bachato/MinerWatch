#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Avalon addpool / removepool / poolpriority test (Donate-hashrate, phase 2b).

Confirms the three commands we still need for donation, the safe way.

It does mutate config briefly, but NEVER mines to a foreign address:
  * addpool — adds a pool pointing at YOUR OWN address (the same User the
    miner already uses), at the lowest priority, so under Failover it is
    NOT mined. Then we read it back to learn the reply shape + new index.
  * removepool — deletes exactly the pool we just added.
  * poolpriority — finally re-sets the priority order to ascending id
    (0,1,2), restoring your original order (and tidying the 1<->2 swap the
    earlier switchpool test left behind).

Worst case if something fails midway: a leftover pool with YOUR address
(harmless, delete it from the web UI). No credentials are used.

Usage:
    python3 avalon_addpool_test.py <miner-ip> [port]
"""
from __future__ import annotations

import json
import socket
import sys
import time

TEST_POOL_URL = "stratum+tcp://solo.ckpool.org:3333"  # your own address is appended


def call(host, port, command, parameter=None, timeout=6.0):
    req = {"command": command}
    if parameter is not None:
        req["parameter"] = parameter
    chunks = []
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(json.dumps(req).encode("ascii"))
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


def msg(reply):
    if isinstance(reply, dict):
        st = reply.get("STATUS")
        if isinstance(st, list) and st:
            return f"{st[0].get('STATUS')}: {st[0].get('Msg')}"
    return str(reply)[:200]


def pools(host, port):
    r = call(host, port, "pools")
    return r.get("POOLS", []) if isinstance(r, dict) else []


def show(rows):
    for p in rows:
        print(f"  POOL {p.get('POOL')}  prio={p.get('Priority')}  "
              f"{p.get('URL')}  user={p.get('User')}")


def main():
    if len(sys.argv) < 2:
        print("usage: python3 avalon_addpool_test.py <miner-ip> [port]")
        return 2
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 4028

    print(f"Avalon addpool/removepool/poolpriority test on {host}:{port}\n")

    base = pools(host, port)
    if not base:
        print("No pools / no reply — aborting.")
        return 1
    base_ids = {p.get("POOL") for p in base}
    own_user = next((p.get("User") for p in base if p.get("Stratum Active")), None) \
        or base[0].get("User")
    print("[1] Baseline:")
    show(base)
    print(f"\n    Reusing your own address as the test worker: {own_user}")

    # --- addpool (your own address → harmless) ---
    param = f"{TEST_POOL_URL},{own_user},x"
    print(f"\n[2] addpool {param}")
    print("    reply:", msg(call(host, port, "addpool", param)))
    time.sleep(2)
    after_add = pools(host, port)
    print("    pools after addpool:")
    show(after_add)

    new_ids = [p.get("POOL") for p in after_add if p.get("POOL") not in base_ids]
    if not new_ids:
        print("\n    addpool did NOT create a new pool (maybe it merged a dup, or"
              " needs credentials). Reply above tells the story. Stopping here so"
              " nothing is left dangling.")
        return 0
    new_id = max(new_ids)
    print(f"\n    -> new pool index = {new_id}")

    # --- removepool (delete exactly what we added) ---
    print(f"\n[3] removepool {new_id}")
    print("    reply:", msg(call(host, port, "removepool", str(new_id))))
    time.sleep(2)
    after_rm = pools(host, port)
    print("    pools after removepool:")
    show(after_rm)

    # --- poolpriority: restore ascending id order (your original 0,1,2) ---
    ids_sorted = sorted(p.get("POOL") for p in after_rm)
    order = ",".join(str(i) for i in ids_sorted)
    print(f"\n[4] poolpriority {order}   (restore original order)")
    print("    reply:", msg(call(host, port, "poolpriority", order)))
    time.sleep(2)
    final = pools(host, port)
    print("    final pools:")
    show(final)

    print("\nDone. Paste the whole output back.")
    print("Expected end state: same 3 pools as your first probe, priorities 0,1,2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
