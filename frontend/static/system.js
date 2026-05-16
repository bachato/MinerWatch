// MinerWatch — System page (host metrics, Raspberry Pi)
//
// Lifecycle:
//   1. On load, GET /api/system/info once. If not a Raspberry, show the
//      "only available on Pi" panel and bail. Otherwise reveal the
//      regular UI + the sidebar System link.
//   2. Poll /api/system/snapshot every 5 s.
//   3. Maintain a 60-point ring buffer of CPU temperature for the
//      mini-chart at the bottom of the page.
//   4. Slider has a manual "Apply" button so the user can finalise a
//      value before sending — POSTs to /api/system/fan.

const SYS_POLL_MS = 5000;
const SYS_TEMP_BUFFER_SIZE = 60;
const sysTempBuffer = []; // {ts, value} entries

let sysPollTimer = null;
let sysFanInfo = { controllable: false, has_rpm: false, max_state: null };

// ---------- Formatters ----------

function sysBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function sysRate(bps) {
    // Render bytes/s as KB/s or MB/s; under 1 KB/s show "<1 KB/s" to
    // avoid noisy "0 B/s" when there's just a trickle of background traffic.
    if (bps === null || bps === undefined || isNaN(bps)) return '—';
    if (bps < 1024) return '<1 KB/s';
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

function sysUptime(seconds) {
    if (!seconds || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function tempColor(t) {
    // Mirrors the threshold colours used on the miner cards so the UI
    // feels consistent: warm at 60, hot at 70, critical at 80.
    if (t === null || t === undefined) return 'var(--text-dim)';
    if (t >= 80) return 'var(--red)';
    if (t >= 70) return 'var(--orange)';
    if (t >= 60) return 'var(--yellow)';
    return 'var(--green)';
}

function cpuPercentColor(p) {
    if (p === null || p === undefined) return 'var(--primary)';
    if (p >= 90) return 'var(--red)';
    if (p >= 70) return 'var(--orange)';
    return 'var(--primary)';
}

// ---------- Throttle badge helpers ----------

function setBadge(el, active, kind) {
    // kind: 'now' (red if active) | 'ever' (yellow if active) | 'off' (green if inactive)
    el.classList.remove(
        'sys-badge-ok', 'sys-badge-warn', 'sys-badge-bad', 'sys-badge-muted'
    );
    if (active === null || active === undefined) {
        el.textContent = '—';
        el.classList.add('sys-badge-muted');
        return;
    }
    if (active) {
        el.textContent = 'yes';
        el.classList.add(kind === 'ever' ? 'sys-badge-warn' : 'sys-badge-bad');
    } else {
        el.textContent = 'no';
        el.classList.add('sys-badge-ok');
    }
}

// ---------- DOM render ----------

function renderHeader(info) {
    document.getElementById('sys-model').textContent = info.model || 'unknown';
    document.getElementById('sys-kernel').textContent = info.kernel || '—';

    // Show the System link in the sidebar of *this* page now that we
    // know we're on a Pi. (Other pages handle that in app.js via the
    // shared info-cache helper — see updateSidebarSystemLink.)
    const navLink = document.querySelector('.nav-link-system');
    if (navLink && info.is_raspberry) navLink.classList.remove('hidden');
}

function renderSnapshot(snap, info) {
    // Uptime + load
    document.getElementById('sys-uptime').textContent = sysUptime(snap.uptime_seconds);
    if (snap.load_average && snap.load_average.length === 3) {
        const [a, b, c] = snap.load_average;
        document.getElementById('sys-load').textContent =
            `${a.toFixed(2)} · ${b.toFixed(2)} · ${c.toFixed(2)}`;
    }

    // ---------- Throttling ----------
    const th = snap.throttled || {};
    const anyNow = th.now_undervoltage || th.now_freq_capped ||
                   th.now_throttled || th.now_soft_temp_limit;
    const anyEver = th.ever_undervoltage || th.ever_freq_capped ||
                    th.ever_throttled || th.ever_soft_temp_limit;
    const badge = document.getElementById('sys-throttle-now');
    const statusBadge = document.getElementById('system-status-badge');
    if (anyNow) {
        badge.textContent = 'issue now';
        badge.className = 'sys-badge sys-badge-bad';
        statusBadge.textContent = 'throttled · now';
        statusBadge.className = 'sys-badge sys-badge-bad';
    } else if (anyEver) {
        badge.textContent = 'past events';
        badge.className = 'sys-badge sys-badge-warn';
        statusBadge.textContent = 'past throttling';
        statusBadge.className = 'sys-badge sys-badge-warn';
    } else if (th.raw !== null && th.raw !== undefined) {
        badge.textContent = 'healthy';
        badge.className = 'sys-badge sys-badge-ok';
        statusBadge.textContent = 'healthy';
        statusBadge.className = 'sys-badge sys-badge-ok';
    } else {
        badge.textContent = '—';
        badge.className = 'sys-badge sys-badge-muted';
        statusBadge.textContent = 'no firmware data';
        statusBadge.className = 'sys-badge sys-badge-muted';
    }
    setBadge(document.getElementById('sys-uv-now'), th.now_undervoltage, 'now');
    setBadge(document.getElementById('sys-th-now'), th.now_throttled, 'now');
    setBadge(document.getElementById('sys-fc-now'), th.now_freq_capped, 'now');
    setBadge(document.getElementById('sys-st-now'), th.now_soft_temp_limit, 'now');
    setBadge(document.getElementById('sys-uv-ever'), th.ever_undervoltage, 'ever');
    setBadge(document.getElementById('sys-th-ever'), th.ever_throttled, 'ever');
    setBadge(document.getElementById('sys-fc-ever'), th.ever_freq_capped, 'ever');
    setBadge(document.getElementById('sys-st-ever'), th.ever_soft_temp_limit, 'ever');

    // ---------- Gauges ----------
    // CPU
    const cpuP = snap.cpu && snap.cpu.percent !== null ? snap.cpu.percent : null;
    const cpuFill = document.getElementById('sys-cpu-fill');
    document.getElementById('sys-cpu-val').textContent = cpuP !== null ? cpuP.toFixed(0) : '—';
    cpuFill.style.width = cpuP !== null ? `${Math.min(100, cpuP)}%` : '0%';
    cpuFill.style.background = cpuPercentColor(cpuP);
    if (snap.cpu && snap.cpu.per_core) {
        document.getElementById('sys-cpu-sub').textContent =
            snap.cpu.per_core.map(p => `${p.toFixed(0)}%`).join(' · ');
    }

    // Memory
    const m = snap.memory || {};
    const memP = m.percent !== null && m.percent !== undefined ? m.percent : null;
    document.getElementById('sys-mem-val').textContent = memP !== null ? memP.toFixed(0) : '—';
    document.getElementById('sys-mem-fill').style.width = memP !== null ? `${memP}%` : '0%';
    document.getElementById('sys-mem-sub').textContent =
        (m.used_bytes !== null && m.total_bytes)
            ? `${sysBytes(m.used_bytes)} / ${sysBytes(m.total_bytes)}`
            : '—';

    // Disk
    const d = snap.disk || {};
    const diskP = d.percent !== null && d.percent !== undefined ? d.percent : null;
    document.getElementById('sys-disk-val').textContent = diskP !== null ? diskP.toFixed(0) : '—';
    document.getElementById('sys-disk-fill').style.width = diskP !== null ? `${diskP}%` : '0%';
    document.getElementById('sys-disk-sub').textContent =
        (d.used_bytes !== null && d.total_bytes)
            ? `${sysBytes(d.used_bytes)} / ${sysBytes(d.total_bytes)}`
            : '—';
    document.getElementById('sys-disk-free').textContent = sysBytes(d.free_bytes);
    document.getElementById('sys-disk-total').textContent = sysBytes(d.total_bytes);

    // Temperature
    const temp = snap.temperature_c;
    document.getElementById('sys-temp-val').textContent =
        temp !== null && temp !== undefined ? temp.toFixed(1) : '—';
    const tempFill = document.getElementById('sys-temp-fill');
    // Map 30..90 °C onto 0..100% width — most home Pis live in that band.
    const tempPct = (temp !== null && temp !== undefined)
        ? Math.max(0, Math.min(100, ((temp - 30) / 60) * 100))
        : 0;
    tempFill.style.width = `${tempPct}%`;
    tempFill.style.background = tempColor(temp);

    // ---------- Fan ----------
    const fan = snap.fan || {};
    const fanPanel = document.getElementById('sys-fan-panel');
    // Always show the panel if we have either RPM or controllable —
    // otherwise hide it entirely so the page is calmer on unconfigured Pis.
    if (sysFanInfo.controllable || sysFanInfo.has_rpm) {
        fanPanel.classList.remove('hidden');
    } else {
        fanPanel.classList.add('hidden');
    }
    document.getElementById('sys-fan-rpm').textContent =
        fan.rpm !== null && fan.rpm !== undefined ? fan.rpm : '—';
    document.getElementById('sys-fan-percent').textContent =
        fan.percent !== null && fan.percent !== undefined ? fan.percent : '—';

    // ---------- Frequency & voltage ----------
    const c = snap.cpu || {};
    document.getElementById('sys-freq').textContent =
        c.freq_mhz !== null && c.freq_mhz !== undefined ? `${c.freq_mhz} MHz` : '—';
    document.getElementById('sys-freq-max').textContent =
        c.freq_max_mhz !== null && c.freq_max_mhz !== undefined ? `${c.freq_max_mhz} MHz` : '—';
    document.getElementById('sys-volts').textContent =
        snap.voltage_core !== null && snap.voltage_core !== undefined
            ? `${snap.voltage_core.toFixed(3)} V` : '—';
    document.getElementById('sys-cores').textContent =
        c.per_core ? c.per_core.length : '—';

    // ---------- I/O ----------
    const io = snap.io || {};
    document.getElementById('sys-net-rx').textContent = sysRate(io.net_rx_bps);
    document.getElementById('sys-net-tx').textContent = sysRate(io.net_tx_bps);
    document.getElementById('sys-disk-read').textContent = sysRate(io.disk_read_bps);
    document.getElementById('sys-disk-write').textContent = sysRate(io.disk_write_bps);

    // ---------- Storage detail ----------
    document.getElementById('sys-db-size').textContent = sysBytes(snap.db_size_bytes);
    const s = snap.swap || {};
    if (s.total_bytes && s.total_bytes > 0) {
        document.getElementById('sys-swap').textContent =
            `${sysBytes(s.used_bytes)} / ${sysBytes(s.total_bytes)} (${s.percent.toFixed(0)}%)`;
    } else {
        document.getElementById('sys-swap').textContent = 'no swap configured';
    }

    // ---------- Temperature chart buffer ----------
    if (temp !== null && temp !== undefined) {
        sysTempBuffer.push({ ts: snap.ts, value: temp });
        while (sysTempBuffer.length > SYS_TEMP_BUFFER_SIZE) sysTempBuffer.shift();
        renderTempChart();
        document.getElementById('sys-trend-current').textContent =
            `Now: ${temp.toFixed(1)} °C`;
    }
}

// ---------- Mini-chart ----------

function renderTempChart() {
    const svg = document.getElementById('sys-temp-chart');
    if (!svg) return;
    const W = svg.clientWidth || 600;
    const H = svg.clientHeight || 120;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (sysTempBuffer.length < 2) {
        svg.innerHTML =
            `<text x="${W / 2}" y="${H / 2}" class="sys-trend-empty" ` +
            `text-anchor="middle">collecting samples…</text>`;
        return;
    }
    // Y range: 30..90 °C is the sweet-spot for a home Pi. Auto-expand
    // if the actual data goes outside that range so we don't clip.
    let yMin = 30, yMax = 90;
    sysTempBuffer.forEach(p => {
        if (p.value < yMin) yMin = Math.floor(p.value - 2);
        if (p.value > yMax) yMax = Math.ceil(p.value + 2);
    });

    const n = sysTempBuffer.length;
    const xStep = W / Math.max(1, SYS_TEMP_BUFFER_SIZE - 1);
    const yScale = v => H - ((v - yMin) / (yMax - yMin)) * H;

    const points = sysTempBuffer.map((p, i) => {
        // Right-align the buffer so the most recent sample is at x=W.
        const x = W - (n - 1 - i) * xStep;
        return `${x.toFixed(1)},${yScale(p.value).toFixed(1)}`;
    }).join(' ');

    // Filled area under the curve for visual weight (matches the
    // hashrate chart style on the dashboard).
    const last = sysTempBuffer[n - 1];
    const first = sysTempBuffer[0];
    const xFirst = W - (n - 1) * xStep;
    const xLast = W;
    const areaPoints =
        `${xFirst.toFixed(1)},${H} ${points} ${xLast.toFixed(1)},${H}`;

    // Gridlines at 50/60/70/80 °C if they fall within range.
    const grids = [50, 60, 70, 80].filter(v => v >= yMin && v <= yMax).map(v => {
        const y = yScale(v).toFixed(1);
        return `<line class="hashrate-chart-grid" x1="0" y1="${y}" x2="${W}" y2="${y}"/>` +
               `<text class="hashrate-chart-label" x="2" y="${parseFloat(y) - 2}">${v}°</text>`;
    }).join('');

    const stroke = tempColor(last.value);
    svg.innerHTML =
        grids +
        `<polygon class="hashrate-chart-area" points="${areaPoints}" ` +
        `style="fill:${stroke};opacity:0.12"/>` +
        `<polyline class="hashrate-chart-line" points="${points}" ` +
        `style="stroke:${stroke}"/>`;
}

// ---------- Fan slider ----------

function initFanControls(info) {
    sysFanInfo = info.fan || sysFanInfo;
    const slider = document.getElementById('sys-fan-slider');
    const readout = document.getElementById('sys-fan-slider-readout');
    const applyBtn = document.getElementById('sys-fan-apply');
    const sliderWrap = document.getElementById('sys-fan-slider-wrap');
    const noControl = document.getElementById('sys-fan-no-control');
    const note = document.getElementById('sys-fan-note');

    if (sysFanInfo.controllable) {
        sliderWrap.classList.remove('hidden');
        noControl.classList.add('hidden');
        // For gpio-fan (max_state=1) the slider can only really do
        // off/on. Surface that so the user isn't confused why 30% and
        // 70% feel identical.
        if (sysFanInfo.max_state === 1) {
            note.textContent =
                'Your fan overlay is gpio-fan: only off (0%) and on (≥50%) are supported. ' +
                'For smooth 0–100% control, switch to dtoverlay=pwm-fan.';
        } else if (sysFanInfo.max_state) {
            note.textContent =
                `PWM resolution: ${sysFanInfo.max_state + 1} steps. ` +
                `The slider rounds to the nearest step before applying.`;
        }
    } else {
        sliderWrap.classList.add('hidden');
        noControl.classList.remove('hidden');
    }

    if (slider) {
        slider.addEventListener('input', () => {
            readout.textContent = `${slider.value}%`;
        });
    }
    if (applyBtn) {
        applyBtn.addEventListener('click', async () => {
            const pct = parseInt(slider.value, 10);
            applyBtn.disabled = true;
            try {
                const r = await api('/api/system/fan', {
                    method: 'POST',
                    body: { percent: pct },
                });
                toast(`Fan set to ${r.applied_percent ?? pct}%`, 'success');
                // Refresh immediately so the user sees the new state
                // without waiting for the next poll tick.
                refreshSnapshot();
            } catch (err) {
                toast(`Fan control failed: ${err.message}`, 'error');
            } finally {
                applyBtn.disabled = false;
            }
        });
    }
}

// ---------- Polling loop ----------

let cachedInfo = null;

async function refreshSnapshot() {
    try {
        const snap = await api('/api/system/snapshot');
        renderSnapshot(snap, cachedInfo);
    } catch (err) {
        // Don't spam the toast for every failed tick (e.g. transient
        // network blip when the user puts the Pi to sleep). Just log.
        console.warn('snapshot failed', err);
    }
}

async function bootSystemPage() {
    try {
        cachedInfo = await api('/api/system/info');
    } catch (err) {
        console.error('system info failed', err);
        document.getElementById('system-status-badge').textContent = 'error';
        return;
    }
    if (!cachedInfo.is_raspberry) {
        // Show the "not a Pi" panel and stop. Sidebar link stays hidden.
        document.getElementById('system-not-raspberry').classList.remove('hidden');
        document.getElementById('system-status-badge').textContent = 'not a Pi';
        return;
    }
    document.getElementById('system-root').classList.remove('hidden');
    renderHeader(cachedInfo);
    initFanControls(cachedInfo);
    // The first snapshot has no I/O rates (no previous reading to diff
    // against). That's fine — they'll be available from the second
    // tick onward.
    await refreshSnapshot();
    sysPollTimer = setInterval(refreshSnapshot, SYS_POLL_MS);
}

document.addEventListener('DOMContentLoaded', bootSystemPage);

// Pause polling when the tab is in the background to be kind to the Pi
// (and to mobile data when you're checking remotely).
document.addEventListener('visibilitychange', () => {
    if (document.hidden && sysPollTimer) {
        clearInterval(sysPollTimer);
        sysPollTimer = null;
    } else if (!document.hidden && !sysPollTimer && cachedInfo && cachedInfo.is_raspberry) {
        refreshSnapshot();
        sysPollTimer = setInterval(refreshSnapshot, SYS_POLL_MS);
    }
});
