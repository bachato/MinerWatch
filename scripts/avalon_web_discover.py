#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Discover the Avalon Nano web-UI pool-config endpoint (Donate-hashrate, phase 2c).

`addpool` isn't supported on the cgminer API, so setting a pool means
hitting whatever HTTP endpoint the miner's own web UI uses. This script
finds that endpoint the safe way: it downloads the web UI's HTML + its
JavaScript bundles and greps them for the API calls (cgi / set / pool /
stratum / conf ...).

READ-ONLY: only HTTP GETs of the UI's own static assets. No POST, no
config writes, no login required for the static JS in most builds. If the
whole UI sits behind auth and we get only a login page, we'll fall back to
a credentialed capture.

Usage:
    python3 avalon_web_discover.py 192.168.1.14
"""
from __future__ import annotations

import re
import sys
import urllib.request
from urllib.parse import urljoin

KEYWORDS = re.compile(
    r"(cgi[-_/]?bin|\.cgi|setpool|set_?miner|miner_?conf|pools?\b|stratum|"
    r"/api/|worker|conf(ig)?|set_?net|/set|priority)",
    re.IGNORECASE,
)
ASSET_RE = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+\.(?:js|css))["\']', re.IGNORECASE)
URLISH_RE = re.compile(r'["\'`](/[A-Za-z0-9_\-./]*?(?:cgi|api|pool|conf|set|stratum)[A-Za-z0-9_\-./]*)["\'`]', re.IGNORECASE)


def get(url: str, timeout: float = 8.0) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "minerwatch-discover/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(800_000).decode("utf-8", "replace")
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001
        print(f"   (fetch error for {url}: {e})")
        return 0, ""


def grep(label: str, text: str) -> None:
    hits = []
    for m in URLISH_RE.finditer(text):
        hits.append(m.group(1))
    # also keyword lines (short context) for inline endpoint strings
    line_hits = []
    for ln in text.splitlines():
        if KEYWORDS.search(ln) and ("cgi" in ln.lower() or "/api" in ln.lower()
                                    or "stratum" in ln.lower() or "setpool" in ln.lower()
                                    or "conf" in ln.lower()):
            s = ln.strip()
            if 3 < len(s) < 240:
                line_hits.append(s)
    uniq_paths = sorted(set(hits))
    if uniq_paths:
        print(f"   [{label}] candidate endpoint paths:")
        for p in uniq_paths[:40]:
            print(f"       {p}")
    if line_hits:
        print(f"   [{label}] interesting lines:")
        for s in line_hits[:25]:
            print(f"       {s}")
    if not uniq_paths and not line_hits:
        print(f"   [{label}] nothing obvious matched.")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python3 avalon_web_discover.py <miner-ip>")
        return 2
    ip = sys.argv[1]
    base = f"http://{ip}"
    print(f"Discovering web UI endpoints on {base}  (read-only HTTP GETs)\n")

    status, html = get(base + "/")
    print(f"GET / -> HTTP {status}, {len(html)} bytes")
    if not html:
        print("Empty index. Try opening http://%s in a browser to confirm it serves a UI." % ip)
        return 1

    grep("index.html", html)

    assets = sorted(set(ASSET_RE.findall(html)))
    print(f"\nFound {len(assets)} linked asset(s).")
    js_assets = [a for a in assets if a.lower().endswith(".js")]
    for a in js_assets[:12]:
        url = urljoin(base + "/", a)
        st, body = get(url)
        print(f"\nGET {a} -> HTTP {st}, {len(body)} bytes")
        if body:
            grep(a, body)

    print("\nDone. Paste the output back — I'm looking for the path the UI POSTs")
    print("pool settings to (something like /cgi-bin/...cgi or /api/...).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
