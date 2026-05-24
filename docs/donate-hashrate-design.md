# Donate Hashrate — Design & Implementation Spec

**Status:** Draft / proposal — not yet implemented.
**Author:** (design session)
**Related code:** `frontend-react/src/components/DonateDialog.tsx`, `frontend-react/src/components/AppShell.tsx`, `backend/main.py`, `backend/miners/*`, `backend/db.py`, `backend/auto_control.py`, `backend/poller.py`
**Precedent doc:** `docs/guardian-design.md` (same style; Guardian is the closest existing "background loop that restores miner state" feature).

---

## 1. Summary

Today "Donate" is a sidebar entry that opens a modal (`DonateDialog`) showing a hardcoded BTC address + QR code. Almost nobody clicks it.

This spec adds a second, lower-friction way to support the project: **donate hashrate**. From a full Donations *page*, a user picks one or more of their miners and a duration (in hours), clicks **Donate**, and MinerWatch temporarily repoints those miners at `solo.ckpool.org` using the project's BTC donation address as the payout. When the timer expires — or the user hits **STOP** — MinerWatch restores each miner's previous pool configuration exactly.

The economic model is **solo-mining lottery**: a donated miner only pays out if it finds a block, and the reward goes to the project's address. This fits MinerWatch's existing identity as a solo-mining monitor for home rigs (Bitaxe / NerdQAxe / Avalon Nano / small Antminers).

---

## 2. Goal & user story

> As a MinerWatch user who likes the tool but doesn't want to send BTC from an exchange, I want to lend the project some of my hashrate for a few hours with one click, see exactly what's happening, and have it automatically revert so I never accidentally keep mining to someone else's address.

Non-goals for v1:

- Not a pooled-payout scheme with per-donor accounting. It's solo lottery to a shared address.
- Not a way to donate to *arbitrary* addresses — only the project's fixed donation address (same trust model as the existing modal).
- Not a percentage/quota split of a single miner's hashrate. v1 donates **whole miners** for a duration. (Quota-based partial donation is a possible v2; see §11.)

---

## 3. How it works (and the honest version we show the user)

This section doubles as the source of truth for the user-facing copy in §7.4.

1. **You choose miners + hours.** Those miners stop mining to wherever they point now and mine to `solo.ckpool.org` with the project's BTC address.
2. **It's a lottery, not a transfer.** Solo mining pays the *full* block reward to whoever finds a block — or nothing. A home miner's odds of finding a block in a few hours are very low. So most donations contribute hashrate (and a shot at the jackpot for the project) without any guaranteed payout. This is the same math the rest of MinerWatch already shows in its "Solo Chance" / prediction widgets.
3. **All donors share one address.** Everyone donates to the *same* project address (only the worker name differs). On solo.ckpool the hashrate competing for a block is aggregated per address, so the more people donating at once, the better the collective odds of the project's address hitting a block. It's one shared lottery ticket, not many tiny separate ones.
4. **It costs you real electricity.** For the donation window you pay power and forego whatever your own pool would have paid you. It's a genuine donation, not free.
5. **It auto-reverts.** After the hours you set, MinerWatch puts every miner back exactly as it was. You can also STOP any miner early. If MinerWatch is restarted/crashes, it catches up on the next boot and still reverts.

---

## 4. Scope for v1: AxeOS only

The single biggest implementation variable is *which miner families can have their pool rewritten*. The repo makes this clear:

| Family | Driver | Control today | Pool-switch effort | v1? |
|---|---|---|---|---|
| **Bitaxe (AxeOS)** | `bitaxe.py` | `can_set_fan/frequency/voltage/restart = True`, all via `PATCH /api/system` | **Trivial** — PATCH stratum fields | ✅ Yes |
| **NerdQAxe / NerdOctaxe** | `nerdoctaxe.py` | Mirrors Bitaxe (`PATCH /api/system`) | **Trivial** — same as Bitaxe (+ dual-pool fields) | ✅ Yes |
| **Canaan / Avalon** | `canaan.py` | `can_set_fan/frequency/voltage/workmode/restart = True` via cgminer | Medium — cgminer `addpool`/`switchpool`/`removepool` | ⏳ v1.1 |
| **Antminer (LuxOS)** | `luxos.py` | **Read-only MVP** — every `can_set_* = False`; needs session `logon`→`SessionID` first | High — blocked on the session-auth work already TODO'd in the driver | ⏳ later |
| **Braiins OS** | `braiins.py` | Mostly read-only (`can_restart = False`); pool config via BOS gRPC | High | ⏳ later |

**Decision: ship v1 for AxeOS (Bitaxe + NerdQAxe) only.** Rationale:

- Pool-switch is a one-line PATCH, no credential/session handling.
- AxeOS devices *are* the core home-solo-mining audience MinerWatch targets — the exact people who'd find "donate a few hours of lottery hashrate" appealing.
- For every other family, the "Donate hashrate" affordance is shown **disabled** with a "not supported yet for <family>" tooltip, gated on a new `can_set_pool` capability flag (§6.1). This degrades gracefully and tells the truth.

> ⚠️ AxeOS applies stratum changes on save but generally needs a **restart** to reconnect to the new pool. The flow must therefore `PATCH` then `restart()` then confirm via the poller. Both drivers already expose `restart()`. (See §8 "restart needed".)

---

## 5. Architecture overview

```
Frontend (React)                         Backend (FastAPI)                       Miner (AxeOS)
────────────────                         ─────────────────                       ─────────────
DonationsPage
 ├─ Donate-BTC info (reuse existing)
 ├─ "How it works" (always visible)
 ├─ Start flow: pick miners + hours ──► POST /api/donations ──┐
 └─ Active donations table             (Miner | 5m hr | left | STOP)
        ▲  ▲                                                  │
        │  └─ STOP ──► POST /api/donations/{id}/stop          │
        │                                                     ▼
        │                                            for each miner:
        │                                            1. read_pool_config()  ── GET /api/system/info ─►
        │                                            2. snapshot → DB (donation_miners)
        │                                            3. set_pool(ckpool, addr.worker) ── PATCH /api/system ─►
        │                                            4. restart() ── POST /api/system/restart ─►
        │                                            5. mark active; ends_ts = now + hours
        │
        └─ GET /api/donations (poll) ◄── reads poller.last_results for 5m hashrate + live pool

DonationController (asyncio background task, modeled on AutoFanController)
 ├─ tick every N s: any donation_miners with ends_ts <= now → revert (restore snapshot → restart → confirm)
 └─ on_startup catch-up: revert anything already past ends_ts while the process was down
```

The whole feature rests on **one durable idea**: the *previous pool config snapshot* + an *absolute end timestamp*, both persisted in SQLite. Everything else (the table UI, the STOP button, the timer) is a view or trigger over that state.

---

## 6. Backend design

### 6.1 Driver layer — new pool capability

Add to `backend/miners/base.py` (`MinerDriver`):

```python
# capability flags (default False, like the existing ones)
can_set_pool: bool = False

async def read_pool_config(self) -> PoolConfig | None:
    """Return the current pool config we'd need to restore later.
    Must capture every slot (primary + fallback) so revert is faithful."""
    raise NotImplementedError

async def set_pool(self, config: PoolConfig) -> bool:
    """Repoint the miner. Returns True if the command was accepted.
    NOTE: acceptance != applied — the caller confirms via the poller."""
    raise NotImplementedError
```

`PoolConfig` is a small dataclass mirroring what AxeOS needs and what `PoolSnapshot` already models: `url`, `port`, `user` (worker), `password`, plus the fallback triplet. (Reuse / sit next to `PoolSnapshot` in `base.py`.)

**AxeOS implementation** (`bitaxe.py`, inherited/extended by `nerdoctaxe.py`) — uses the existing `_patch_system()` helper:

```python
can_set_pool = True

async def read_pool_config(self) -> PoolConfig:
    # GET /api/system/info — today this is done inline in poll(); extract a
    # small _system_info() helper so both poll() and this can share it.
    data = await self._system_info()
    return PoolConfig(
        url=data.get("stratumURL"), port=data.get("stratumPort"),
        user=data.get("stratumUser"), password=data.get("stratumPassword", "x"),
        fb_url=data.get("fallbackStratumURL"),
        fb_port=data.get("fallbackStratumPort"),
        fb_user=data.get("fallbackStratumUser"),
    )

async def set_pool(self, cfg: PoolConfig) -> bool:
    ok = await self._patch_system({
        "stratumURL": cfg.url, "stratumPort": cfg.port,
        "stratumUser": cfg.user, "stratumPassword": cfg.password,
    })
    # stratum changes need a restart to reconnect on AxeOS
    if ok:
        await self.restart()
    return ok
```

> The AxeOS field names (`stratumURL`, `stratumPort`, `stratumUser`, `stratumPassword`, and the `fallback*` variants) must be verified against the firmware version matrix MinerWatch supports — they've been stable across recent ESP-Miner/NerdQAxe builds but a quick check on a real device is part of the test plan (§10). The `pool_url` / `worker` MinerWatch already parses in `poll()` confirms these are readable.

Extend `_capabilities(family)` in `main.py` to include `"set_pool": cls.can_set_pool`, so the frontend knows per-family whether to enable the button.

For Canaan/LuxOS/Braiins, leave `can_set_pool = False` for now (Canaan is the natural next family; LuxOS is gated behind the session-auth work already noted in its docstring).

### 6.2 Data model (SQLite, `backend/db.py`)

Follow the existing pattern: add `CREATE TABLE IF NOT EXISTS` blocks to the schema string and register any later changes in the migrations list (the same way `fan_mode`, `guardian_*` columns were added via `ALTER TABLE`).

```sql
-- One row per "Donate hashrate" action (may span several miners).
CREATE TABLE IF NOT EXISTS donations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_ts   INTEGER NOT NULL,
    ends_ts      INTEGER NOT NULL,           -- ABSOLUTE epoch; never a duration
    status       TEXT NOT NULL DEFAULT 'active',  -- active | completed | stopped | partial_error
    worker_name  TEXT NOT NULL,              -- e.g. "<addr>.donations"
    note         TEXT
);

-- One row per miner inside a donation. Holds the snapshot to restore.
CREATE TABLE IF NOT EXISTS donation_miners (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    donation_id   INTEGER NOT NULL,
    miner_id      INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',  -- active | reverted | error | unreachable
    prev_pool     TEXT NOT NULL,             -- JSON: full PoolConfig snapshot (all slots)
    applied_ts    INTEGER,                   -- when switch confirmed on the miner
    reverted_ts   INTEGER,
    last_error    TEXT,
    FOREIGN KEY (donation_id) REFERENCES donations(id) ON DELETE CASCADE,
    FOREIGN KEY (miner_id)    REFERENCES miners(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_donation_miners_active
    ON donation_miners(status) WHERE status = 'active';
```

Notes:

- **`ends_ts` is absolute.** This is what makes "time remaining" survive a restart and what powers the boot catch-up. Never store "3 hours".
- **`prev_pool` is the spine of the feature.** Snapshot the *entire* current pool config (primary + fallback) before overwriting, so revert is byte-faithful even if the user had a custom fallback.
- A miner can only be in **one active donation at a time** — enforce in `POST /api/donations` (reject or ignore miners already active). Guards against double-snapshot clobbering.

### 6.3 DonationController — background loop + boot catch-up

Model directly on `backend/auto_control.py::AutoFanController`: an `asyncio` task, started in `main.py`'s `@app.on_event("startup")` and stopped in `@app.on_event("shutdown")`, ticking every N seconds. New file `backend/donations.py`.

```python
class DonationController:
    async def start(self):  ...   # create_task(self._run())
    async def stop(self):   ...

    async def catch_up_on_boot(self):
        """Run ONCE at startup before/with start(). Revert any donation_miners
        whose donation.ends_ts <= now that are still 'active' — i.e. the timer
        expired while the process was down. This is the crash safety net."""

    async def _run(self):
        while not self._stop.is_set():
            await self._tick()
            await asyncio.wait_for(self._stop.wait(), timeout=TICK_SECONDS)  # ~30s

    async def _tick(self):
        now = int(time.time())
        for dm in await db.active_donation_miners_due(now):   # ends_ts <= now
            await self._revert_one(dm)

    async def _revert_one(self, dm):
        # same idiom as auto_control.py:
        miner = await db.get_miner(dm["miner_id"])
        drv = driver_for_record({**miner, "timeout": get_config().polling.request_timeout})
        if not drv.can_set_pool:
            await db.mark_donation_miner(dm["id"], status="error",
                                         error="driver lost set_pool capability")
            return
        try:
            cfg = PoolConfig.from_json(dm["prev_pool"])
            ok = await drv.set_pool(cfg)          # restores snapshot (+ restart)
            # confirm via poller on a later tick; for now mark reverted/error
            await db.mark_donation_miner(dm["id"],
                status="reverted" if ok else "error",
                reverted_ts=now if ok else None)
        except Exception as e:
            await db.mark_donation_miner(dm["id"], status="error", error=str(e))
            # leave 'active' on transient failure? -> keep retrying next tick
```

Key behaviors:

- **Tick cadence ~30 s** is plenty (donations are measured in hours); keeps network traffic minimal, consistent with the project's "don't hammer miners" stance in `auto_control.py`.
- **Retry on transient failure.** If a miner is unreachable at revert time, do *not* flip it to `reverted`. Keep it `active`/`error` and retry on subsequent ticks; surface "unreachable" in the API so the user sees it. The donation is only truly done when every miner is `reverted`.
- **Confirm the switch actually landed.** The poller (`poller.last_results[miner_id].pool_url` / `.worker`) already records where each miner is pointed. Use it to (a) confirm the donation switch reached `solo.ckpool` after start, and (b) confirm revert returned the miner to its previous URL. Mark `applied_ts`/`reverted_ts` only when the poller confirms, not merely when the command returned 200.

### 6.4 API endpoints (mirror the existing `control/*` style in `main.py`)

```
POST   /api/donations
       body: { miner_ids: int[], hours: float, }
       → snapshots + switches each miner; creates donations + donation_miners rows.
       → returns the created donation with per-miner status (started | error | unsupported).

GET    /api/donations            → list active donations, each with per-miner:
       { miner_id, name, hashrate_5m, pool_ok, ends_ts, status }
       hashrate_5m + pool_ok come from poller.last_results.

GET    /api/donations/{id}       → single donation detail.

POST   /api/donations/{id}/stop          → revert ALL miners in the donation now.
POST   /api/donations/{id}/miners/{mid}/stop → revert ONE miner now (the table's STOP button).
```

Pydantic payloads alongside `FanPayload`/`FreqPayload`. Reuse `_resolve_driver(miner_id)`. Reject miners whose family has `can_set_pool = False` with a clear per-miner error rather than failing the whole request.

### 6.5 solo.ckpool integration constants

```python
CKPOOL_SOLO_URL  = "solo.ckpool.org"
CKPOOL_SOLO_PORT = 3333
# user = "<btc_address>.<worker>"   e.g. bc1q...zjudxu.donations
# password = "x" (ignored by ckpool)
DONATION_WORKER  = "donations"   # or "minerwatch" — see open question §11
```

The BTC address is currently hardcoded in `DonateDialog.tsx` (`bc1qexhamvrpclpr2skyyw3u8edm8kznnvt6zjudxu`). **Move it to one shared source of truth** used by both the donate-BTC info block and the worker-name builder. Frontend: a `lib/donation.ts` constant; the worker string is built backend-side too (don't trust the client to supply the address — the server owns it, same as the modal's "every install sees the same address" model). Note: solo.ckpool charges a ~2% fee on found blocks; mention nowhere user-facing is required but keep it in mind.

---

## 7. Frontend design

### 7.1 Make Donations a real page (not a modal)

In `AppShell.tsx`, the `Donate` entry is currently `kind: 'action'` that calls `setDonateOpen(true)`. Change it to a normal `kind: 'link'`:

```ts
{ kind: 'link', to: '/donations', label: 'Donate', icon: Heart,
  description: 'Support MinerWatch', iconClassName: 'text-red-500' }
```

- Remove the `onDonateClick` plumbing and the `<DonateDialog>` instance from `AppShell` (or keep `donateOpen` state unused — cleaner to remove).
- **Keep `DonateDialog.tsx` in the repo, unused**, per the request to be able to reinstate the modal later. Add a one-line comment at its top: "Currently unmounted — superseded by DonationsPage; retained for possible reuse."
- Add the route in `App.tsx`: `<Route path="/donations" element={<DonationsPage />} />`.

### 7.2 `DonationsPage.tsx` layout (full classic page)

Top to bottom, a single scrollable page using the existing `Card` / `Button` / `Input` / `Slider` / `Switch` / `Badge` primitives in `components/ui`:

1. **Support MinerWatch (BTC)** — reuse the *content* of today's `DonateDialog` (QR via `qrcode.react`, address `<code>`, copy button with the same 3-strategy clipboard logic). Extract that body into a shared `DonateBtcCard` component so both the page and the (retained) dialog can render it. This is "what they see now," kept at hand as requested.

2. **Donate hashrate — how it works** — an always-visible explainer card (the §3 / §7.4 copy). Not collapsed, not a tooltip. This satisfies "le informazioni base su come funziona chiaramente scritte e visibili."

3. **Start a donation** — miner multi-select (checkbox list of the user's miners; each row shows name + family + current 5-min hashrate; miners whose family `can_set_pool` is false are listed but disabled with "not supported yet"). Duration input in hours (number input or slider, e.g. 1–72 h). A prominent confirmation line restating the cost + lottery nature, then a **Donate** button.

4. **Active donations** — the table requested:

   | Miner | Hashrate (5 min) | Time remaining | Status | |
   |---|---|---|---|---|
   | Bitaxe-01 | 1.1 TH/s | 2h 14m | ● Donating | **STOP** |
   | NerdQAxe-A | — | 0h 47m | ⚠ Unreachable | **STOP** |

   - One row per active `donation_miner` across all donations (flattened), so the user sees everything at a glance.
   - `Status`: Donating (confirmed on solo.ckpool) / Switching… (command sent, not yet confirmed) / Unreachable / Reverting / Error. Never silently drop a row.
   - `STOP` = revert *now* for that miner; show a spinner until confirmed, then remove the row (or show "Reverted ✓" briefly). A "Stop all" button at the top of the table.
   - This section is the crash safety net's UI: after a restart the page rebuilds it from `GET /api/donations`, so the user can always see and stop active donations even if the auto-revert timer was interrupted.

### 7.3 API hooks / types

In `src/api/hooks.ts` (React Query, like `useUpdateCheck`): `useDonations()` (polling, ~10–15 s), `useStartDonation()`, `useStopDonation()`, `useStopDonationMiner()`. Add types to `src/lib/types.ts`. Add the address/worker constant to `src/lib/donation.ts`.

### 7.4 User-facing copy (ready to paste)

**How-it-works card:**

> **Donate hashrate**
> Lend MinerWatch some of your mining power instead of sending BTC. Pick one or more miners and how long, and they'll mine to MinerWatch's Bitcoin address on solo.ckpool for that time — then switch back automatically.
>
> - **It's a lottery, not a transfer.** Solo mining pays the whole block reward to whoever finds a block, or nothing. Over a few hours a home miner's odds are small — you're contributing hashrate and a shot at the jackpot, not a fixed amount.
> - **Everyone shares one address**, so all donated hashrate competes for blocks together — the more people donating at once, the better the collective odds.
> - **It costs you real electricity** and the pool revenue you'd have earned for that time. It's a genuine donation.
> - **It reverts automatically** when the timer ends. You can STOP any miner early, and active donations stay visible here even after a restart.

**Confirmation line (above the Donate button):**

> You're about to donate **{n} miner(s)** for **{hours} h**. They'll mine to MinerWatch's address (solo lottery) and pay you nothing during this time. They'll switch back automatically at {end time}.

**Empty active-donations state:**

> No active donations. When you donate hashrate, your miners show up here with a live status and a STOP button.

---

## 8. Edge cases & failure handling

- **MinerWatch down at revert time** → boot catch-up (§6.3) reverts on next start; the active-donations table is the manual fallback. Residual gap: host stays off indefinitely *and* user never reopens → miner keeps donating. Acceptable given MinerWatch is a 24/7 LAN service; document it, don't pretend it's impossible.
- **Miner unreachable at start** → don't create an active row claiming success; return per-miner `error` and don't snapshot a switch that didn't happen.
- **Miner unreachable at revert** → keep retrying each tick; show **Unreachable** in the table; never mark `reverted` until confirmed.
- **AxeOS restart needed** → `set_pool()` issues PATCH then `restart()`. There's a reconnect gap (tens of seconds) where the miner is offline/booting — the table should treat "offline right after a switch" as **Switching…**, not an error, for a grace window.
- **User changes pool manually during the window** → on revert we'd overwrite their manual change with the pre-donation snapshot. Low-probability; decision in §11. Minimum: the snapshot is taken at start, so we restore *that*, which is the documented behavior.
- **Partial failure across miners** → donation `status = partial_error`; per-miner statuses tell the story; STOP/Stop-all still work per miner.
- **Double-donation of same miner** → rejected at `POST /api/donations` (unique active constraint, §6.2).
- **Process restart mid-donation (not expired)** → timer is reconstructed from absolute `ends_ts`; the loop simply continues; no special handling needed.

---

## 9. Security & trust

A button that repoints someone's hashrate to a third-party address is, mechanically, what cryptojacking does. The defense is radical transparency and consent, not obscurity:

- **Fixed address only**, owned/served by the backend — never an address the client can set. Same trust model as the existing modal.
- **Explicit per-action consent** with the cost/lottery wording shown every time.
- **Always-visible control** (active-donations table + STOP) and **automatic revert**.
- **Open-source & local-first** — the address and behavior are auditable in-repo (MinerWatch is AGPL-3.0, no cloud). Keep the donation address in one obvious place.
- **No new credentials stored for AxeOS** (open LAN REST). When Canaan/LuxOS land, their write-auth/session secrets must be handled with the same care as any other miner credential — call this out in those families' tickets.

---

## 10. Testing plan

- **Unit:** `PoolConfig` round-trip (read → snapshot JSON → restore); `set_pool` payload shape for AxeOS; due-selection query (`ends_ts <= now AND status='active'`).
- **Driver (real device or mock AxeOS):** confirm `read_pool_config()` captures primary+fallback; confirm PATCH+restart actually reconnects to solo.ckpool; confirm revert restores the exact prior URL/worker. **Verify the AxeOS stratum field names** on the firmware versions in scope.
- **Controller:** simulate (a) normal expiry, (b) STOP, (c) crash-then-boot catch-up with an already-expired donation, (d) unreachable-at-revert retry loop.
- **Frontend:** start flow with mixed supported/unsupported families; table status transitions (Switching → Donating → Reverting → gone); rebuild table after a backend restart.
- **End-to-end on a Bitaxe:** donate 1 miner for the minimum duration, watch it appear on solo.ckpool stats for the project address, confirm auto-revert.

---

## 11. Open questions / decisions

1. **Worker name:** `donations` vs `minerwatch` vs per-install id. A constant string lets the project see aggregate donated hashrate on solo.ckpool; a per-install suffix would let donors find *their* contribution but fragments the view. Recommendation: fixed `donations` (or `mw-donations`).
2. **Duration cap & granularity:** propose 1–72 h, default 6 h. Hard cap avoids "forgot it running for a week."
3. **Quota/partial donation (v2):** AxeOS has only one active pool, so partial-hashrate donation isn't possible on AxeOS without multi-pool quota (which AxeOS lacks). Whole-miner is the right v1; revisit if Braiins/LuxOS (which support quota) come online.
4. **Manual-pool-change-during-window** handling: restore snapshot blindly (simple, documented) vs detect drift and skip revert (safer, more complex). Recommend simple-restore for v1, documented in the UI.
5. **Show estimated odds?** MinerWatch already computes solo-find probability (`/api/fleet/prediction`). Could show "expected odds of a block during this donation" — nice honesty touch, optional for v1.

---

## 12. Implementation checklist (phased)

**Phase 1 — Backend core (AxeOS):**
- [ ] `PoolConfig` dataclass + `can_set_pool` / `read_pool_config()` / `set_pool()` on `MinerDriver` (`base.py`).
- [ ] AxeOS impl in `bitaxe.py`; verify inheritance/overrides in `nerdoctaxe.py` (dual-pool fields).
- [ ] `donations` + `donation_miners` tables + migrations in `db.py`; DB helpers (create, list active, due, mark, get).
- [ ] `donations.py` `DonationController` + `catch_up_on_boot()`; wire into `main.py` startup/shutdown next to `auto_fan`.
- [ ] API endpoints + Pydantic models in `main.py`; extend `_capabilities()` with `set_pool`.
- [ ] solo.ckpool constants + server-owned address/worker builder.

**Phase 2 — Frontend:**
- [ ] Extract `DonateBtcCard` from `DonateDialog`; keep `DonateDialog` unmounted-but-retained.
- [ ] Nav entry action→link; route in `App.tsx`; `DonationsPage.tsx` (4 sections).
- [ ] Hooks/types/constant; active-donations table with statuses + STOP / Stop-all.
- [ ] Copy from §7.4.

**Phase 3 — Hardening & later families:**
- [ ] Tests (§10) incl. crash/boot catch-up and unreachable retry.
- [ ] Canaan `set_pool` (cgminer `addpool`/`switchpool`) → flip `can_set_pool`.
- [ ] LuxOS/Braiins after their write-auth/session work lands.

---

## 13. File-by-file change map

| File | Change |
|---|---|
| `backend/miners/base.py` | `PoolConfig` dataclass; `can_set_pool`; `read_pool_config()`; `set_pool()` |
| `backend/miners/bitaxe.py` | implement the three above; `set_pool` = PATCH stratum + restart |
| `backend/miners/nerdoctaxe.py` | inherit/override for dual-pool |
| `backend/db.py` | 2 new tables + migrations + helper queries |
| `backend/donations.py` | **new** — `DonationController`, catch-up, revert logic |
| `backend/main.py` | startup/shutdown wiring; `/api/donations*` routes; `_capabilities` += `set_pool` |
| `backend/poller.py` | (no change — reuse `last_results` pool_url/worker for confirmation) |
| `frontend-react/src/App.tsx` | add `/donations` route |
| `frontend-react/src/components/AppShell.tsx` | Donate nav: action→link; drop modal mount |
| `frontend-react/src/components/DonateDialog.tsx` | keep, mark retained-for-reuse; export shared `DonateBtcCard` |
| `frontend-react/src/pages/DonationsPage.tsx` | **new** — the full page |
| `frontend-react/src/api/hooks.ts` | donation hooks |
| `frontend-react/src/lib/types.ts` | donation types |
| `frontend-react/src/lib/donation.ts` | **new** — address + worker constant |
