# MinerWatch — Security Review

> Internal security review / findings backlog. This is **not** the
> public disclosure policy — that lives in [`SECURITY.md`](SECURITY.md).
> This document captures an internal audit so that, when we decide to
> harden a given area, the analysis is already done.
>
> - **Reviewed version:** 1.9.1
> - **Scope:** `backend/` (FastAPI app, auth, updater, discovery,
>   drivers), `frontend-react/`, Docker/Compose, the Umbrel
>   community-app-store distribution.
> - **Threat model note:** MinerWatch ships as a *local-first, trusted-LAN*
>   service. Several findings below are explicitly accepted by the current
>   `SECURITY.md` ("attacker on your LAN" is out of scope). They are listed
>   anyway because (a) the default posture exposes them to attackers who are
>   *not* on the LAN (see F1), and (b) they define the work needed if we ever
>   want to support a stricter "untrusted network" mode.

## Summary table

| #  | Finding | Severity | Status |
|----|---------|----------|--------|
| F1 | No `Host`-header validation → DNS-rebinding | **High** | Open |
| F2 | Default `0.0.0.0` + auth off + destructive endpoints | **High** | By design (needs UX nudge) |
| F3 | Auth token *is* the password (cleartext cookie, plaintext in DB) | **Medium-High** | Open |
| F4 | Updater verifies integrity but not authenticity (no signature) | **Medium-High** | Open |
| F5 | Stale dependencies + no CI security scanning | **Medium** | Open |
| F6 | Umbrel distribution disables proxy auth (`PROXY_AUTH_ADD: false`) | **Medium** | Open |
| F7 | Mutable image tag in published Compose (no digest pin) | **Low-Medium** | Open |
| F8 | Misc: SSRF-by-design, VAPID key at rest, `.DS_Store` leak | **Low** | Open |

Severity reflects *real-world* risk given the default config, not the
trusted-LAN assumption.

---

## F1 — No `Host`-header validation (DNS-rebinding) — **High**

**Where:** `backend/main.py` — CORS is configured with
`allow_origin_regex = PRIVATE_ORIGIN_REGEX` (≈ lines 66–85). There is no
`TrustedHostMiddleware` and no check of the incoming `Host` header.

**Problem.** The CORS regex only governs *cross-origin reads* in a browser.
It does nothing against **DNS rebinding**: a public site (`evil.com`) is
served to the victim, then re-resolves its own domain to the MinerWatch
LAN IP after the DNS TTL expires. The browser now treats requests to
MinerWatch as *same-origin* with `evil.com`, so CORS never applies.

**Impact.**
- With the default `auth.enabled: false`, *any website the user visits*
  can read all fleet data **and** issue state-changing/destructive calls
  (restart miners, change frequency/voltage → possible hardware damage,
  pool/payout reconfiguration).
- With auth enabled, the `mw_token` cookie is bound to the LAN-IP/hostname
  origin and is **not** sent to the `evil.com` origin, so enabling auth
  already mitigates the worst case — but the *default* is unprotected.

**Remediation.**
- Add an allow-list on the `Host` header (FastAPI/Starlette
  `TrustedHostMiddleware`, or a small custom middleware) accepting only
  `localhost`, `127.0.0.1`, `*.local`, and RFC1918 literals — the same
  shape as `PRIVATE_ORIGIN_REGEX`. Reject everything else with `400`.
- This defeats rebinding **regardless of whether auth is on**, which is why
  it is the single highest value/effort fix in this document.

---

## F2 — Default `0.0.0.0` + auth disabled + destructive endpoints — **High**

**Where:** `config.example.yaml` (`server.host: 0.0.0.0`, `auth.enabled:
false`); `backend/config.py` `AuthCfg` (≈ lines 93–95, defaults
`enabled=False`, `password=""`).

**Problem.** Out of the box the service binds every interface with no
authentication, while exposing endpoints that restart miners and change
frequency/voltage. Anything that can route to the host — a compromised
IoT device, a guest-network bleed, a roommate, or F1 above — has full
control.

**Note.** Accepted in the current `SECURITY.md` as the trusted-LAN
assumption, so this is a **UX/by-design** item rather than a code bug.

**Remediation (low effort, high payoff).**
- First-run banner / setup step in the UI: "Auth is disabled — anyone on
  your network can view *and control* your miners." with a one-click "Set a
  password".
- Optionally default-bind to `127.0.0.1` and make `0.0.0.0` an explicit
  opt-in, *or* refuse to serve write endpoints on a non-loopback bind until
  a password is set.
- Document the hardened posture (auth on + bind scope) prominently in the
  README, not only in `SECURITY.md`.

---

## F3 — Auth token is the password itself — **Medium-High**

**Where:** `backend/main.py` login handler (≈ lines 1390–1452): on success
the cookie value is `payload.password` verbatim. `backend/auth.py` compares
the provided value against `cfg.auth.password`. The password is persisted
in the `settings` table (`backend/db.py`, table at ≈ line 156) as a
plaintext key/value row.

**What is done well.** Constant-time compare (`hmac.compare_digest`),
fail-closed when enabled-but-empty, per-IP login lockout, and the cookie is
`HttpOnly` + `SameSite=Lax`.

**Problems.**
1. The cookie carries the **literal password** on every request. Over plain
   HTTP on the LAN it is sniffable.
2. It is a **single shared secret**: no per-session tokens, no revocation,
   no rotation without changing everyone's password.
3. The password sits in the DB **in plaintext**; any file read, backup
   copy, or path leak discloses it directly.

**Remediation.**
- On successful login, mint a random session token server-side, store only
  its hash, and set *that* as the `mw_token` cookie (with expiry/rotation).
- Store the configured password as a salted hash; compare against the hash.
- Consider an optional TLS story for non-loopback use (self-signed /
  `mkcert` guidance) so the cookie isn't cleartext on the wire.

---

## F4 — Updater verifies integrity, not authenticity — **Medium-High**

**Where:** `backend/updater.py` — `_fetch_sha256()` (≈ line 227) pulls
`checksums.txt` from the **same GitHub release** as the tarball;
`install_update()` (≈ line 430+) downloads, checks SHA256, then
`_rsync_swap()` overwrites app files and the process restarts.

**What is done well.** Tar-slip defense (`_safe_extract`), size check,
atomic file replacement, refusal to install without a checksum.

**Problem.** The checksum and the tarball share a trust root. SHA256 here
proves *the file wasn't corrupted in transit* — it does **not** prove *who
produced it*. A compromised maintainer account, a malicious GHCR/release
push, or a registry MITM yields **remote code execution** on every
installation that runs the in-app updater (which executes the new code with
the app's privileges after swap+restart).

**Remediation.**
- Sign releases (`minisign` or `cosign`); ship the **public** key in the
  repo; verify the signature *before* `_safe_extract`/`_rsync_swap`. Refuse
  to install on signature failure.
- Treat the in-app self-update as privileged: log the exact files replaced,
  and consider a "verify-only / dry-run" mode.

---

## F5 — Stale dependencies + no CI security scanning — **Medium**

**Where:** `requirements.txt` (all pins ≈ Sep–Oct 2024);
`.github/workflows/` contains `ci.yml`, `docker-publish.yml`, `release.yml`
— **none** run Dependabot, `pip-audit`, CodeQL, Trivy, or similar.

**Problem.** Pins are ~1.5 years old as of this review. Notably:
- `jinja2==3.1.4` — fixes landed in 3.1.5 / 3.1.6 (e.g. CVE-2024-56201,
  CVE-2025-27516).
- `cryptography==43.0.1` — newer security releases exist upstream.
- `fastapi==0.115.0`, `httpx==0.27.2`, etc. — verify each with a scanner.

(Exploitability depends on usage; the point is there is **no automated
signal** telling us when a dependency becomes vulnerable.)

**Remediation.**
- Add `pip-audit` (and `npm audit` for the frontend) as a CI job.
- Enable Dependabot (or Renovate) for `requirements.txt`,
  `frontend-react/package.json`, GitHub Actions, and Dockerfile base images.
- Add a Trivy scan of the published image in `docker-publish.yml`.

---

## F6 — Umbrel distribution disables proxy auth — **Medium**

**Where:** `minerwatch-app-store/imlenti-minerwatch/docker-compose.yml` —
`app_proxy` sets `PROXY_AUTH_ADD: "false"`.

**Problem.** This opts out of umbrelOS's own authentication wrapper, so on
Umbrel the app relies *entirely* on MinerWatch's auth — which is off by
default (F2). Result: a default Umbrel install exposes the dashboard and its
control endpoints with no auth at all.

**Remediation.**
- Either leave Umbrel's proxy auth enabled, or force `auth.enabled: true`
  with a generated password for the Umbrel build, or surface a mandatory
  first-run password step. Document the choice in the app manifest.

---

## F7 — Mutable image tag in published Compose — **Low-Medium**

**Where:** `minerwatch-app-store/imlenti-minerwatch/docker-compose.yml` —
`image: ghcr.io/imlenti/minerwatch:1.9.1`. An in-file comment already notes
that production should pin a digest.

**Problem.** A tag is mutable: the bytes behind `:1.9.1` can change after
publication. Users who reinstall/repull may silently get different code.

**Remediation.** Pin `ghcr.io/imlenti/minerwatch:1.9.1@sha256:<digest>` and
update the digest as part of the release process.

---

## F8 — Lower-severity / accepted items — **Low**

- **SSRF by design.** Miner `host` is user-supplied and the poller issues
  HTTP requests to it. Intended on a trusted LAN, but combined with F1/F2 an
  attacker could add a "miner" pointing at an internal service and use
  MinerWatch as a probe/proxy. Mitigated mostly by fixing F1.
- **VAPID private key at rest.** Stored unencrypted in the data dir; key
  disclosure enables forged push notifications (already in-scope in
  `SECURITY.md`). Ensure restrictive file permissions on the data dir.
- **Per-process, per-IP login lockout.** State resets on restart and is
  bypassable behind a proxy that rewrites the client IP. Acceptable for LAN;
  revisit if a stricter mode is added.
- **`.DS_Store` files** present in the tree (`backend/`, `backend/miners/`,
  repo root, and the app-store folder). Minor directory-structure leak —
  add to `.gitignore` and remove from history.

---

## Suggested order of work

1. **F1** — `Host`-header allow-list (kills rebinding regardless of auth).
2. **F2 / F6** — make a password mandatory (or default-on) for non-loopback
   and Umbrel installs; first-run nudge.
3. **F4** — sign releases and verify before applying updates.
4. **F3** — session tokens + hashed password at rest.
5. **F5** — `pip-audit` / Dependabot / Trivy in CI.
6. **F7 / F8** — digest pin and housekeeping.

*Generated as an internal review aid; line numbers are approximate and
refer to version 1.9.1.*
