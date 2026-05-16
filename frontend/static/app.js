// MinerWatch — shared utilities + dashboard

const POLL_MS = 5000;

// ---------- API helpers ----------

async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const resp = await fetch(path, {
        ...opts,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
    });
    if (!resp.ok) {
        let detail = `${resp.status}`;
        try { detail = (await resp.json()).detail || detail; } catch {}
        throw new Error(detail);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ---------- Toast ----------

function ensureToastContainer() {
    let el = document.getElementById('toast-container');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast-container';
        document.body.appendChild(el);
    }
    return el;
}

function toast(message, kind = 'info', timeout = 3500) {
    const container = ensureToastContainer();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), timeout);
}

window.toast = toast;
window.api = api;

// ---------- Sidebar: reveal the "System" link only on Raspberry Pi ----------
//
// Every page that has a sidebar ships a hidden ".nav-link-system" entry
// that we unhide here when /api/system/info reports is_raspberry=true.
// The check is cached for the rest of the browser session via
// sessionStorage so we don't hit the API on every nav.
//
// Failures are deliberately swallowed: on a non-Pi host the link stays
// hidden and no error is surfaced — that's the intended outcome, not a
// bug to report.

(async function revealSystemLinkIfPi() {
    if (!document.querySelector('.nav-link-system')) return;  // no sidebar on this page
    const cached = sessionStorage.getItem('mw_is_raspberry');
    if (cached === '1') {
        document.querySelectorAll('.nav-link-system').forEach(el => el.classList.remove('hidden'));
        return;
    }
    if (cached === '0') return;  // negative cache lasts for the session
    try {
        const info = await fetch('/api/system/info', { credentials: 'same-origin' });
        if (!info.ok) return;
        const data = await info.json();
        if (data && data.is_raspberry) {
            sessionStorage.setItem('mw_is_raspberry', '1');
            document.querySelectorAll('.nav-link-system').forEach(el => el.classList.remove('hidden'));
        } else {
            sessionStorage.setItem('mw_is_raspberry', '0');
        }
    } catch (_) { /* offline / 401 → leave hidden */ }
})();

// ---------- Formatters ----------

function fmtNum(value, decimals = 2, unit = '') {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const n = Number(value);
    return `${n.toFixed(decimals)}${unit ? ' ' + unit : ''}`;
}

function fmtUptime(seconds) {
    if (!seconds || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function fmtRelative(timestamp) {
    if (!timestamp) return '—';
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function tempClass(t) {
    if (t === null || t === undefined) return '';
    if (t >= 80) return 'critical';
    if (t >= 70) return 'hot';
    if (t >= 60) return 'warm';
    return '';
}

// Format a raw difficulty number (e.g. 4_290_000_000) into a compact
// human string with SI suffix ("4.29 G"). Mirrors the AxeOS UI so users
// see numbers in the same shape they'd see on the miner's own page.
function fmtDifficulty(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const n = Number(value);
    if (n === 0) return '0';
    const abs = Math.abs(n);
    const units = [
        { v: 1e24, s: 'Y' },
        { v: 1e21, s: 'Z' },
        { v: 1e18, s: 'E' },
        { v: 1e15, s: 'P' },
        { v: 1e12, s: 'T' },
        { v: 1e9,  s: 'G' },
        { v: 1e6,  s: 'M' },
        { v: 1e3,  s: 'k' },
    ];
    for (const u of units) {
        if (abs >= u.v) {
            return `${(n / u.v).toFixed(decimals)} ${u.s}`;
        }
    }
    return `${n.toFixed(decimals >= 2 ? 0 : decimals)}`;
}

window.fmtNum = fmtNum;
window.fmtUptime = fmtUptime;
window.fmtRelative = fmtRelative;
window.tempClass = tempClass;
window.fmtDifficulty = fmtDifficulty;

// ---------- Dashboard ----------

const dashboardEl = document.getElementById('dashboard-root');

if (dashboardEl) {
    initDashboard();
}

async function initDashboard() {
    await renderDashboard();
    setInterval(renderDashboard, POLL_MS);

    const addBtn = document.getElementById('btn-add-miner');
    if (addBtn) addBtn.addEventListener('click', openAddMinerModal);

    const scanBtn = document.getElementById('btn-scan');
    if (scanBtn) scanBtn.addEventListener('click', handleScan);
}

async function renderDashboard() {
    try {
        const [{ miners }, { current: cfg }] = await Promise.all([
            api('/api/miners'),
            api('/api/settings'),
        ]);
        // Reflect the *current* polling interval (read from the same
        // settings the backend poller actually uses) in the toolbar
        // subtitle, so changing it on /settings is visible on the home
        // page the next time renderDashboard ticks (≤ POLL_MS).
        updateSubtitleInterval(cfg);
        renderFleetSummary(miners);
        renderMiners(miners);
        renderCriticalBanner(miners, cfg);
        await Promise.all([
            renderAlerts(),
            updateHashrateChart(miners),
            renderBestShares(miners),
            renderBlockFinds(),
        ]);
    } catch (err) {
        toast(`Error loading: ${err.message}`, 'error');
    }
}

// Update the dashboard toolbar subtitle to reflect the live polling
// interval. The interval lives in cfg.polling.interval_seconds — same
// value the backend poller uses — so when the user changes it on the
// /settings page, the home page subtitle catches up on the next tick.
function updateSubtitleInterval(cfg) {
    const el = document.getElementById('subtitle');
    if (!el) return;
    const seconds = cfg && cfg.polling && Number(cfg.polling.interval_seconds);
    const label = Number.isFinite(seconds) && seconds > 0 ? `${seconds}s` : '—s';
    el.textContent = `Polling every ${label} · data straight from miners on the LAN`;
}

// Block-finds trophy card. Pulls every persisted block-found event
// from the backend and renders a celebratory card at the top of the
// dashboard. The card hides itself when the list is empty — most home
// solo miners will go years without seeing one, so the default state
// is "invisible".
async function renderBlockFinds() {
    const card = document.getElementById('block-finds-card');
    if (!card) return;
    let data;
    try {
        data = await api('/api/fleet/block_finds');
    } catch {
        card.classList.add('hidden');
        return;
    }
    const finds = data.block_finds || [];
    if (!finds.length) {
        card.classList.add('hidden');
        return;
    }
    const entries = finds.map((f) => {
        const date = new Date((f.ts || 0) * 1000);
        const dateStr = date.toLocaleString();
        const share = fmtDifficulty(f.share_difficulty);
        const network = fmtDifficulty(f.network_difficulty);
        const heightHtml = f.block_height
            ? ` · block <strong>#${f.block_height}</strong>`
            : '';
        return `
            <div class="block-find-entry">
                <div class="block-find-trophy">🏆</div>
                <div class="block-find-body">
                    <div class="block-find-title">
                        <strong>${escapeHtml(f.miner_name)}</strong> found a block
                    </div>
                    <div class="block-find-meta">
                        share <strong>${share}</strong> ≥ network <strong>${network}</strong>
                        · ${escapeHtml(dateStr)}${heightHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');
    card.classList.remove('hidden');
    card.innerHTML = `
        <div class="block-finds-header">
            <div class="block-finds-title">🎉 Blocks found</div>
            <div class="block-finds-subtitle">
                ${finds.length === 1 ? '1 block' : `${finds.length} blocks`} mined by this fleet — kept forever
            </div>
        </div>
        <div class="block-finds-list">${entries}</div>
    `;
}

// Best-share card: fleet session/all-time values fetched from the
// dedicated endpoint. Falls back to a compact "no record yet" state
// when no miner has produced a share yet (typical on a fresh install).
async function renderBestShares(miners) {
    const card = document.getElementById('best-shares-card');
    if (!card) return;

    let records;
    try {
        records = await api('/api/fleet/best_difficulty');
    } catch {
        card.classList.add('hidden');
        return;
    }

    const minerName = (id) => {
        const m = miners.find((x) => x.id === id);
        return m ? m.name : `Miner #${id}`;
    };

    const renderEntry = (label, sub, rec) => {
        if (!rec || !rec.value) {
            return `
                <div class="best-share-entry">
                    <div class="best-share-label">${label}</div>
                    <div class="best-share-value">—</div>
                    <div class="best-share-meta">${sub}</div>
                </div>
            `;
        }
        const name = minerName(rec.miner_id);
        return `
            <div class="best-share-entry">
                <div class="best-share-label">${label}</div>
                <div class="best-share-value">${fmtDifficulty(rec.value)}</div>
                <div class="best-share-meta">
                    <a href="/miner/${rec.miner_id}">${escapeHtml(name)}</a>
                    · ${fmtRelative(rec.ts)}
                </div>
            </div>
        `;
    };

    card.classList.remove('hidden');
    card.innerHTML = `
        <div class="best-share-header">
            <div class="best-share-title">Best share — fleet</div>
            <div class="best-share-subtitle">Session resets when a miner reboots · all-time persists in MinerWatch</div>
        </div>
        <div class="best-share-grid">
            ${renderEntry('Session', 'since the last reboot', records.session)}
            ${renderEntry('All-time', 'tracked by MinerWatch', records.alltime)}
        </div>
    `;
}

function renderCriticalBanner(miners, cfg) {
    const bar = document.getElementById('critical-bar');
    if (!bar) return;
    if (!cfg) { bar.classList.add('hidden'); return; }

    const chipMax = cfg.alerts.temp_chip_threshold;
    const vrMax = cfg.alerts.temp_vr_threshold;
    const hot = [];

    for (const m of miners) {
        if (!m.live_online) continue;
        const lm = m.last_metric || {};
        const tChip = lm.temp_chip_c;
        const tVr = lm.temp_vr_c;
        const probs = [];
        if (tChip !== null && tChip !== undefined && tChip >= chipMax) {
            probs.push(`chip ${Number(tChip).toFixed(1)}°C ≥ ${chipMax}°C`);
        }
        if (tVr !== null && tVr !== undefined && tVr >= vrMax) {
            probs.push(`VR ${Number(tVr).toFixed(1)}°C ≥ ${vrMax}°C`);
        }
        if (probs.length) hot.push({ name: m.name, id: m.id, problems: probs });
    }

    if (!hot.length) {
        bar.classList.add('hidden');
        return;
    }

    bar.className = 'alerts-bar';  // removes .hidden, default = red border
    const list = hot.map((h) => `<a href="/miner/${h.id}"><strong>${escapeHtml(h.name)}</strong></a> · ${h.problems.join(', ')}`).join(' ; ');
    bar.innerHTML = `🔥 <strong>Critical status:</strong> ${list}`;
}

function renderFleetSummary(miners) {
    const summaryEl = document.getElementById('fleet-summary');
    if (!summaryEl) return;

    const online = miners.filter((m) => m.live_online).length;
    let totalHash = 0;
    let totalPower = 0;
    let maxTemp = null;

    for (const m of miners) {
        const lm = m.last_metric || {};
        if (m.live_online && lm.hashrate_ths !== null) totalHash += Number(lm.hashrate_ths) || 0;
        if (m.live_online && lm.power_w !== null) totalPower += Number(lm.power_w) || 0;
        if (lm.temp_chip_c !== null) {
            const t = Number(lm.temp_chip_c);
            if (maxTemp === null || t > maxTemp) maxTemp = t;
        }
    }
    const efficiency = totalHash > 0 ? totalPower / totalHash : null;

    summaryEl.innerHTML = `
        <div class="summary-card">
            <div class="summary-label">Miners online</div>
            <div class="summary-value">${online}<span class="unit">/ ${miners.length}</span></div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Total hashrate</div>
            <div class="summary-value">${fmtNum(totalHash, 2)}<span class="unit">TH/s</span></div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Total power</div>
            <div class="summary-value">${fmtNum(totalPower, 0)}<span class="unit">W</span></div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Efficiency</div>
            <div class="summary-value">${efficiency ? fmtNum(efficiency, 1) : '—'}<span class="unit">W/TH</span></div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Max chip temp</div>
            <div class="summary-value ${tempClass(maxTemp)}">${maxTemp !== null ? fmtNum(maxTemp, 1) : '—'}<span class="unit">°C</span></div>
        </div>
    `;
}

function renderMiners(miners) {
    const root = document.getElementById('dashboard-root');
    if (!miners.length) {
        root.innerHTML = `
            <div class="empty">
                <h3>No miners yet</h3>
                <p>Run an automatic network scan or add one manually.</p>
                <div style="display:flex;gap:8px;justify-content:center">
                    <button class="primary" onclick="document.getElementById('btn-scan').click()">Auto scan</button>
                    <button onclick="document.getElementById('btn-add-miner').click()">Add manually</button>
                </div>
            </div>
        `;
        return;
    }

    root.innerHTML = `<div class="miner-grid">${miners.map(renderMinerCard).join('')}</div>`;
}

function renderMinerCard(m) {
    const lm = m.last_metric || {};
    const status = m.live_online === false ? 'offline'
                 : m.live_online === true ? 'online'
                 : (m.last_status || 'pending');

    const tempC = lm.temp_chip_c;
    const tempV = lm.temp_vr_c;
    const familyLabel = { bitaxe: 'Bitaxe', canaan: 'Canaan', braiins: 'Braiins' }[m.family] || m.family;

    return `
        <div class="miner-card" onclick="window.location.href='/miner/${m.id}'">
            <div class="miner-card-header">
                <div>
                    <div class="miner-name">${escapeHtml(m.name)}</div>
                    <div class="miner-host">${familyLabel} · ${escapeHtml(m.host)}</div>
                </div>
                <div><span class="status-dot ${status}"></span>${status}</div>
            </div>
            <div class="miner-metrics">
                <div class="metric-row">
                    <div class="metric-label">Hashrate</div>
                    <div class="metric-value">${fmtNum(lm.hashrate_ths, 2)} <span style="font-size:11px;color:var(--text-dim)">TH/s</span></div>
                </div>
                <div class="metric-row">
                    <div class="metric-label">Power</div>
                    <div class="metric-value">${fmtNum(lm.power_w, 0)} <span style="font-size:11px;color:var(--text-dim)">W</span></div>
                </div>
                <div class="metric-row">
                    <div class="metric-label">Temp chip</div>
                    <div class="metric-value ${tempClass(tempC)}">${fmtNum(tempC, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span></div>
                </div>
                <div class="metric-row">
                    <div class="metric-label">Temp VR</div>
                    <div class="metric-value ${tempClass(tempV)}">${fmtNum(tempV, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span></div>
                </div>
                <div class="metric-row">
                    <div class="metric-label">Fan</div>
                    <div class="metric-value">${lm.fan_rpm || '—'} <span style="font-size:11px;color:var(--text-dim)">rpm</span></div>
                </div>
                <div class="metric-row">
                    <div class="metric-label">Uptime</div>
                    <div class="metric-value" style="font-size:14px">${fmtUptime(lm.uptime_s)}</div>
                </div>
            </div>
            <div class="miner-card-footer">
                <span>${escapeHtml(m.model || '')}</span>
                <span>${fmtRelative(m.last_seen_ts)}</span>
            </div>
        </div>
    `;
}

async function renderAlerts() {
    const bar = document.getElementById('alerts-bar');
    if (!bar) return;
    try {
        const { alerts } = await api('/api/alerts?only_unack=true&limit=5');
        if (!alerts.length) { bar.classList.add('hidden'); return; }
        const last = alerts[0];
        const cls = last.severity === 'critical' ? '' : (last.severity === 'warning' ? 'warning' : 'info');
        bar.className = `alerts-bar ${cls}`;
        bar.innerHTML = `
            <strong>${alerts.length} unread alerts</strong> ·
            ${escapeHtml(last.message)}
            <button style="margin-left:auto" onclick="ackAllAlerts()">Mark all as read</button>
        `;
    } catch {
        bar.classList.add('hidden');
    }
}

window.ackAllAlerts = async () => {
    const { alerts } = await api('/api/alerts?only_unack=true&limit=200');
    await Promise.all(alerts.map((a) => api(`/api/alerts/${a.id}/ack`, { method: 'POST' })));
    toast('Alerts marked as read', 'success');
    await renderDashboard();
};

// ---------- Add miner modal ----------

function openAddMinerModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop open';
    modal.innerHTML = `
        <div class="modal">
            <h3>Add miner</h3>
            <div class="field">
                <label>Family</label>
                <select id="add-family">
                    <option value="bitaxe">Bitaxe / NerdQAxe (HTTP :80)</option>
                    <option value="canaan">Canaan Avalon / Nano 3s (TCP :4028)</option>
                    <option value="braiins">Braiins BMM / BOSminer (TCP :4028)</option>
                </select>
            </div>
            <div class="field">
                <label>Host / IP</label>
                <input id="add-host" placeholder="192.168.1.100" />
            </div>
            <div class="field">
                <label>Port (leave empty for default)</label>
                <input id="add-port" placeholder="80 or 4028" />
            </div>
            <div class="field">
                <label>Name (optional)</label>
                <input id="add-name" placeholder="e.g., Garage Bitaxe Gamma" />
            </div>
            <div class="modal-actions">
                <button onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
                <button class="primary" id="btn-add-confirm">Add</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#btn-add-confirm').addEventListener('click', async () => {
        const payload = {
            family: modal.querySelector('#add-family').value,
            host: modal.querySelector('#add-host').value.trim(),
            port: parseInt(modal.querySelector('#add-port').value) || null,
            name: modal.querySelector('#add-name').value.trim() || null,
        };
        if (!payload.host) { toast('Enter IP/hostname', 'error'); return; }
        try {
            await api('/api/miners', { method: 'POST', body: payload });
            toast('Miner added', 'success');
            modal.remove();
            await renderDashboard();
        } catch (err) {
            toast(`Error: ${err.message}`, 'error');
        }
    });
}

async function handleScan() {
    toast('Network scan in progress (may take ~30 seconds)...', 'info', 8000);
    try {
        const { found } = await api('/api/discovery/scan', { method: 'POST', body: {} });
        toast(`Found ${found.length} miners`, 'success');
        await renderDashboard();
    } catch (err) {
        toast(`Scan error: ${err.message}`, 'error');
    }
}

window.handleScan = handleScan;

// ---------- Fleet hashrate chart ----------
//
// Shows the total fleet hashrate with 1-minute buckets over the last
// hour. On startup, history is loaded from the backend; on each
// dashboard poll (5s) the current minute bucket is updated live with
// the sum of current ``hashrate_ths`` values (each driver normalizes
// to a moving window: Bitaxe = instant, Avalon = MHS 5m/1m,
// Braiins = GHS 1m).

const HASHRATE_CHART_WINDOW_MIN = 60;
const HASHRATE_CHART_BUCKET_S = 60;
const hashrateChart = {
    points: [],            // [{bucket_ts, total_ths}]
    historyLoaded: false,  // first /api/fleet/hashrate_history call done?
    lastBucket: null,
};

function chartBucketTs(ts = Math.floor(Date.now() / 1000)) {
    return Math.floor(ts / HASHRATE_CHART_BUCKET_S) * HASHRATE_CHART_BUCKET_S;
}

async function loadHashrateHistory() {
    try {
        const data = await api(
            `/api/fleet/hashrate_history?minutes=${HASHRATE_CHART_WINDOW_MIN}` +
            `&bucket_seconds=${HASHRATE_CHART_BUCKET_S}`,
        );
        hashrateChart.points = (data.points || []).map((p) => ({
            bucket_ts: Number(p.bucket_ts),
            total_ths: Number(p.total_ths) || 0,
        }));
        hashrateChart.historyLoaded = true;
    } catch {
        // If history fails, we start live: each poll adds a point.
        hashrateChart.historyLoaded = true;
    }
}

async function updateHashrateChart(miners) {
    const card = document.getElementById('fleet-hashrate-chart');
    if (!card) return;

    if (!hashrateChart.historyLoaded) {
        await loadHashrateHistory();
    }

    // Live hashrate: sum of hashrate_ths of online miners. Consistent
    // with the "Total hashrate" value shown in the summary.
    let liveTotal = 0;
    let liveSamples = 0;
    for (const m of miners) {
        if (!m.live_online) continue;
        const lm = m.last_metric || {};
        if (lm.hashrate_ths !== null && lm.hashrate_ths !== undefined) {
            liveTotal += Number(lm.hashrate_ths) || 0;
            liveSamples += 1;
        }
    }

    const valueEl = document.getElementById('hashrate-chart-value');
    if (valueEl) valueEl.textContent = liveSamples > 0 ? fmtNum(liveTotal, 2) : '—';

    // Update the current bucket: average between the value already present
    // for this minute (from the DB or previous polls) and the live one.
    const bucket = chartBucketTs();
    if (liveSamples > 0) {
        const points = hashrateChart.points;
        const last = points[points.length - 1];
        if (last && last.bucket_ts === bucket) {
            // Incremental average: smoothly blends live + history for the minute.
            last.total_ths = (last.total_ths + liveTotal) / 2;
        } else {
            points.push({ bucket_ts: bucket, total_ths: liveTotal });
        }
        // Keep only the last HASHRATE_CHART_WINDOW_MIN minutes.
        const cutoff = bucket - HASHRATE_CHART_WINDOW_MIN * 60;
        while (points.length && points[0].bucket_ts < cutoff) points.shift();
    }

    card.classList.remove('hidden');
    drawHashrateChart();
}

// We draw the SVG in pixel coordinates (no viewBox stretching) to avoid
// distorting text/points. We redraw on container resize.
let _hashrateChartResizeObserver = null;

function drawHashrateChart() {
    const svg = document.getElementById('hashrate-chart-svg');
    if (!svg) return;

    // Attach the ResizeObserver only the first time.
    if (!_hashrateChartResizeObserver && typeof ResizeObserver !== 'undefined') {
        _hashrateChartResizeObserver = new ResizeObserver(() => drawHashrateChart());
        _hashrateChartResizeObserver.observe(svg.parentElement);
    }

    const body = svg.parentElement;
    const W = Math.max(200, Math.round(body.clientWidth));
    const H = Math.max(120, Math.round(body.clientHeight));
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const points = hashrateChart.points;
    const padL = 44;
    const padR = 14;
    const padT = 10;
    const padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    if (!points.length) {
        svg.innerHTML = `
            <text x="${W / 2}" y="${H / 2}" text-anchor="middle"
                  class="hashrate-chart-label" style="font-size:13px">
                Collecting data…
            </text>
        `;
        return;
    }

    // Time range: fixed window ending at the most recent bucket, so the
    // chart doesn't "jitter" as new samples arrive.
    const endTs = points[points.length - 1].bucket_ts;
    const startTs = endTs - HASHRATE_CHART_WINDOW_MIN * 60;
    const tsSpan = (endTs - startTs) || 1;

    // Y range: 0 → max + 10% headroom for readability.
    let maxY = 0;
    for (const p of points) {
        if (p.total_ths > maxY) maxY = p.total_ths;
    }
    if (maxY <= 0) maxY = 1;
    const yMax = maxY * 1.1;

    const x = (ts) => padL + ((ts - startTs) / tsSpan) * innerW;
    const y = (v) => padT + innerH - (v / yMax) * innerH;

    // Line path + area path (semi-transparent fill under the line).
    let line = '';
    let area = '';
    points.forEach((p, i) => {
        const px = x(p.bucket_ts);
        const py = y(p.total_ths);
        line += (i === 0 ? 'M' : 'L') + px.toFixed(2) + ',' + py.toFixed(2) + ' ';
        if (i === 0) area += `M${px.toFixed(2)},${(padT + innerH).toFixed(2)} `;
        area += 'L' + px.toFixed(2) + ',' + py.toFixed(2) + ' ';
    });
    const lastX = x(points[points.length - 1].bucket_ts);
    area += `L${lastX.toFixed(2)},${(padT + innerH).toFixed(2)} Z`;

    // Y-axis: 3 ticks (0, 50%, 100% of range).
    const yTicks = [0, yMax / 2, yMax].map((v) => ({
        v,
        label: fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2),
        py: y(v),
    }));

    // X-axis: ~5 evenly spaced time ticks.
    const xTicks = [];
    const N = 5;
    for (let i = 0; i <= N; i++) {
        const t = startTs + (tsSpan * i) / N;
        const date = new Date(t * 1000);
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        xTicks.push({ t, label: `${hh}:${mm}`, px: x(t) });
    }

    const gridLines = yTicks
        .map((t) => `<line class="hashrate-chart-grid" x1="${padL}" x2="${W - padR}" y1="${t.py}" y2="${t.py}"/>`)
        .join('');
    const yLabels = yTicks
        .map((t) => `<text class="hashrate-chart-label" x="${padL - 6}" y="${t.py + 3}" text-anchor="end">${t.label}</text>`)
        .join('');
    const xLabels = xTicks
        .map((t, i) => {
            const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
            return `<text class="hashrate-chart-label" x="${t.px}" y="${H - 6}" text-anchor="${anchor}">${t.label}</text>`;
        })
        .join('');

    svg.innerHTML = `
        ${gridLines}
        <line class="hashrate-chart-axis" x1="${padL}" x2="${W - padR}" y1="${padT + innerH}" y2="${padT + innerH}"/>
        <path class="hashrate-chart-area" d="${area}"/>
        <path class="hashrate-chart-line" d="${line}"/>
        ${yLabels}
        ${xLabels}
        <g id="hashrate-chart-hover" style="display:none">
            <line class="hashrate-chart-hover-line" x1="0" x2="0" y1="${padT}" y2="${padT + innerH}"/>
            <circle class="hashrate-chart-hover-dot" r="4" cx="0" cy="0"/>
        </g>
        <rect id="hashrate-chart-overlay" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}"
              fill="transparent" style="cursor:crosshair"/>
    `;

    // Interactive tooltip: re-attach handlers every time we redraw (innerHTML
    // removes them). Compute the data point closest to the mouse.
    const overlay = svg.querySelector('#hashrate-chart-overlay');
    const hoverGroup = svg.querySelector('#hashrate-chart-hover');
    const hoverLine = hoverGroup.querySelector('line');
    const hoverDot = hoverGroup.querySelector('circle');
    const tooltip = document.getElementById('hashrate-chart-tooltip');

    const showHover = (evt) => {
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0) return;
        const mx = evt.clientX - rect.left;
        const ts = startTs + ((mx - padL) / innerW) * tsSpan;
        // Closest point in time.
        let best = points[0];
        let bestDelta = Math.abs(points[0].bucket_ts - ts);
        for (const p of points) {
            const d = Math.abs(p.bucket_ts - ts);
            if (d < bestDelta) { best = p; bestDelta = d; }
        }
        const px = x(best.bucket_ts);
        const py = y(best.total_ths);
        hoverGroup.style.display = '';
        hoverLine.setAttribute('x1', px);
        hoverLine.setAttribute('x2', px);
        hoverDot.setAttribute('cx', px);
        hoverDot.setAttribute('cy', py);
        const date = new Date(best.bucket_ts * 1000);
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        tooltip.innerHTML = `
            <div><strong>${fmtNum(best.total_ths, 2)} TH/s</strong></div>
            <div class="tt-time">${hh}:${mm}</div>
        `;
        tooltip.style.left = px + 'px';
        tooltip.style.top = py + 'px';
        tooltip.classList.add('visible');
    };
    const hideHover = () => {
        hoverGroup.style.display = 'none';
        if (tooltip) tooltip.classList.remove('visible');
    };
    overlay.addEventListener('mousemove', showHover);
    overlay.addEventListener('mouseleave', hideHover);
}

// ---------- Helpers ----------

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

window.escapeHtml = escapeHtml;
