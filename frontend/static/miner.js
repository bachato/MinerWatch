// Miner detail page: live stats, Chart.js charts, fan/voltage/frequency controls

const minerId = parseInt(window.location.pathname.split('/').pop(), 10);
let currentRange = 86400;
let chartHash, chartTemp;
let pollTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
    setupRangeButtons();
    setupActions();
    await renderAll();
    pollTimer = setInterval(renderLiveOnly, 5000);
});

function setupRangeButtons() {
    document.querySelectorAll('.range-buttons button').forEach((btn) => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.range-buttons button').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentRange = parseInt(btn.dataset.range, 10);
            await renderCharts();
        });
    });
}

function setupActions() {
    document.getElementById('btn-restart').addEventListener('click', async () => {
        if (!confirm('Restart the miner?')) return;
        try {
            await api(`/api/miners/${minerId}/control/restart`, { method: 'POST' });
            toast('Restart command sent', 'success');
        } catch (err) {
            toast(`Error: ${err.message}`, 'error');
        }
    });
    document.getElementById('btn-delete').addEventListener('click', async () => {
        if (!confirm('Remove this miner from the list? (historical data will be deleted)')) return;
        await api(`/api/miners/${minerId}`, { method: 'DELETE' });
        window.location.href = '/';
    });
}

async function renderAll() {
    const data = await api(`/api/miners/${minerId}`);
    renderHeader(data);
    renderLiveStats(data);
    renderHardware(data);
    renderControls(data);
    await Promise.all([renderCharts(), renderMinerBestShares(data.miner)]);
}

async function renderLiveOnly() {
    try {
        const data = await api(`/api/miners/${minerId}`);
        renderLiveStats(data);
        await renderMinerBestShares(data.miner);
    } catch {}
}

// Per-miner best-share card. Same visual language as the fleet card on
// the home page, but scoped to a single device. Hidden when the API
// returns no records (fresh miner with no shares yet).
async function renderMinerBestShares(miner) {
    const card = document.getElementById('best-shares-card');
    if (!card) return;
    let records;
    try {
        records = await api(`/api/miners/${minerId}/best_difficulty`);
    } catch {
        card.classList.add('hidden');
        return;
    }
    if (!records || (!records.session && !records.alltime)) {
        card.classList.add('hidden');
        return;
    }
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
        return `
            <div class="best-share-entry">
                <div class="best-share-label">${label}</div>
                <div class="best-share-value">${fmtDifficulty(rec.value)}</div>
                <div class="best-share-meta">${fmtRelative(rec.ts)}</div>
            </div>
        `;
    };

    card.classList.remove('hidden');
    card.innerHTML = `
        <div class="best-share-header">
            <div class="best-share-title">Best share — ${escapeHtml(miner.name)}</div>
            <div class="best-share-subtitle">Session resets at miner reboot · all-time persists in MinerWatch</div>
        </div>
        <div class="best-share-grid">
            ${renderEntry('Session', 'since the last reboot', records.session)}
            ${renderEntry('All-time', 'tracked by MinerWatch', records.alltime)}
        </div>
    `;
}

function renderHeader({ miner }) {
    const familyLabel = { bitaxe: 'Bitaxe / NerdQAxe', canaan: 'Canaan Avalon', braiins: 'Braiins / BMM' }[miner.family] || miner.family;
    document.getElementById('miner-title').textContent = miner.name;
    document.getElementById('miner-subtitle').textContent =
        `${familyLabel} · ${miner.host}${miner.port ? ':' + miner.port : ''}${miner.mac ? ' · ' + miner.mac : ''}`;
}

function renderLiveStats({ miner, last_metric, live_sample }) {
    const el = document.getElementById('live-stats');
    const lm = last_metric || {};
    const ls = live_sample || {};
    const status = miner.last_status || 'unknown';

    // We prefer live values (fresher and with extra fields like temp_outlet_c)
    // and fall back to DB if polling hasn't arrived yet.
    const v = (key) => (ls[key] !== null && ls[key] !== undefined) ? ls[key] : lm[key];

    const hashrate = v('hashrate_ths');
    const power = v('power_w');
    const tempChip = v('temp_chip_c');
    const tempVr = v('temp_vr_c');
    const tempOut = ls.temp_outlet_c;
    const tempIn = ls.temp_inlet_c;
    const tempAvg = ls.temp_avg_c;
    const family = miner.family;

    // For Canaan, "Temp VR" is a proxy (OTemp = air outlet), label it
    // more clearly. For Bitaxe and Braiins it remains "Temp VR" (real sensor).
    const vrLabel = family === 'canaan' ? 'Air outlet temp' : 'Temp VR';

    const cells = [
        ['Status', `<span class="status-dot ${status}"></span>${status}${ls.error ? ' · ' + escapeHtml(ls.error) : ''}`],
        ['Hashrate', `${fmtNum(hashrate, 2)} <span style="font-size:11px;color:var(--text-dim)">TH/s</span>`],
        ['Power', `${fmtNum(power, 1)} <span style="font-size:11px;color:var(--text-dim)">W</span>`],
        ['Efficiency', power && hashrate ? fmtNum(power / hashrate, 1) + ' W/TH' : '—'],
        ['Max chip temp', `<span class="${tempClass(tempChip)}">${fmtNum(tempChip, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span></span>`],
    ];
    if (tempAvg !== null && tempAvg !== undefined) {
        cells.push(['Average chip temp', `<span class="${tempClass(tempAvg)}">${fmtNum(tempAvg, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span></span>`]);
    }
    cells.push([vrLabel, `<span class="${tempClass(tempVr)}">${fmtNum(tempVr, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span></span>`]);
    if (tempIn !== null && tempIn !== undefined) {
        cells.push(['Air inlet temp', `${fmtNum(tempIn, 1)} <span style="font-size:11px;color:var(--text-dim)">°C</span>`]);
    }
    cells.push(
        ['Fan', `${v('fan_rpm') || '—'} rpm${v('fan_pct') ? ' · ' + v('fan_pct') + '%' : ''}`],
        ['Frequency', v('frequency_mhz') ? `${v('frequency_mhz')} MHz` : '—'],
        ['Voltage', v('voltage_mv') ? `${v('voltage_mv')} mV` : '—'],
        ['ASIC count', ls.asic_count || '—'],
        ['Uptime', fmtUptime(v('uptime_s'))],
        ['Accepted / Rejected', `${v('accepted') ?? '—'} / ${v('rejected') ?? '—'}`],
        ['Best difficulty (session)', v('best_difficulty') ? fmtDifficulty(v('best_difficulty')) : '—'],
    );

    el.innerHTML = cells.map(([label, val]) => `
        <div class="metric-row">
            <div class="metric-label">${label}</div>
            <div class="metric-value">${val}</div>
        </div>`).join('');
}

function renderHardware({ miner, last_metric }) {
    const el = document.getElementById('hw-info');
    const lm = last_metric || {};
    el.innerHTML = `
        <table>
            <tr><th>Model</th><td>${escapeHtml(miner.model || '—')}</td></tr>
            <tr><th>MAC</th><td style="font-family:ui-monospace,monospace">${escapeHtml(miner.mac || '—')}</td></tr>
            <tr><th>Host</th><td>${escapeHtml(miner.host)}${miner.port ? ':' + miner.port : ''}</td></tr>
            <tr><th>Pool</th><td>${escapeHtml(lm.pool_url || '—')}</td></tr>
            <tr><th>Worker</th><td>${escapeHtml(lm.worker || '—')}</td></tr>
            <tr><th>Notes</th><td>${escapeHtml(miner.notes || '')}</td></tr>
        </table>
    `;
}

function renderControls({ miner, capabilities }) {
    const el = document.getElementById('controls');
    const note = document.getElementById('capabilities-note');
    const items = [];

    // ---- FAN: manual slider + AUTO with target temp ----
    if (capabilities.set_fan) {
        const mode = miner.fan_mode || 'firmware';
        const isAuto = mode === 'minerwatch' || mode === 'firmware';
        const targetC = miner.auto_target_c || 65;
        // Slider starting %: if manual, use the last commanded percentage,
        // otherwise default 50%.
        const startPct = (mode === 'manual' && miner.last_metric && miner.last_metric.fan_pct)
            ? Math.round(miner.last_metric.fan_pct)
            : 50;

        items.push(`
            <div class="control-block" style="grid-column: span 2">
                <h3>Fan</h3>

                <!-- Current mode indicator -->
                <p class="subtitle" style="font-size:12px;margin:0 0 14px">
                    Current mode:
                    <strong id="fan-mode-label" style="color:var(--primary)">${mode === 'manual' ? '✋ Manual' : (mode === 'minerwatch' ? '🎯 AUTO (MinerWatch)' : '🤖 AUTO (firmware)')}</strong>
                </p>

                <!-- Manual slider + Apply + AUTO -->
                <label>Speed: <strong id="fan-pct-label">${startPct}</strong>%</label>
                <input type="range" id="ctl-fan-pct" min="0" max="100" value="${startPct}" style="width:100%;margin:6px 0 10px" />
                <div class="row" style="gap:8px">
                    <button class="primary" id="btn-fan-apply" style="flex:1">Apply</button>
                    <button id="btn-fan-auto" style="flex:1">AUTO</button>
                </div>

                <!-- Target temp for AUTO mode -->
                <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
                    <label>Target temperature for AUTO (°C)</label>
                    <div class="row" style="gap:8px;margin-top:4px">
                        <input type="number" id="ctl-target" min="40" max="90" step="0.5" value="${targetC}" style="flex:1" />
                        <button id="btn-target-save">Save target</button>
                    </div>
                    <p class="subtitle" style="font-size:11px;margin-top:6px">
                        Chip hint: BM1370 (Bitaxe Gamma) ~60-65°C · BM1397 ~65-70°C · Avalon Nano3s ~70-75°C.
                    </p>
                </div>
            </div>
        `);
    }

    // ---- ASIC Frequency and Core Voltage: temporarily disabled ----
    // Re-enable the buttons here if in the future you want to restore
    // direct overclock/undervolt control from the UI. The capability is
    // still exposed by drivers via capabilities.set_frequency / set_voltage,
    // and the backend already has /control/frequency and /control/voltage endpoints.
    /*
    if (capabilities.set_frequency) {
        items.push(`
            <div class="control-block">
                <h3>ASIC Frequency</h3>
                <label>MHz</label>
                <div class="row">
                    <input type="number" id="ctl-freq" min="200" max="2000" />
                    <button onclick="sendControl('frequency', { mhz: parseInt(document.getElementById('ctl-freq').value, 10) })">Set</button>
                </div>
            </div>
        `);
    }
    if (capabilities.set_voltage) {
        items.push(`
            <div class="control-block">
                <h3>Core voltage</h3>
                <label>mV</label>
                <div class="row">
                    <input type="number" id="ctl-volt" min="800" max="2000" />
                    <button onclick="sendControl('voltage', { millivolts: parseInt(document.getElementById('ctl-volt').value, 10) })">Set</button>
                </div>
            </div>
        `);
    }
    */

    if (!items.length) {
        note.textContent = 'Write controls are not yet supported for this miner family. Only toolbar commands are available (Restart, Remove).';
    } else {
        note.innerHTML = '<strong>Apply</strong> = sets a fixed percentage. <strong>AUTO</strong> = MinerWatch adjusts speed every 30s to keep chip temp near target. For Avalon, firmware only accepts % in range 15-100 (below 15 = firmware auto).';
    }
    el.innerHTML = items.join('');

    // ---- Event listeners ----
    const slider = document.getElementById('ctl-fan-pct');
    if (slider) {
        slider.addEventListener('input', () => {
            document.getElementById('fan-pct-label').textContent = slider.value;
        });
    }
    const btnApply = document.getElementById('btn-fan-apply');
    if (btnApply) btnApply.addEventListener('click', applyManualFan);

    const btnAuto = document.getElementById('btn-fan-auto');
    if (btnAuto) btnAuto.addEventListener('click', enableAutoFan);

    const btnTarget = document.getElementById('btn-target-save');
    if (btnTarget) btnTarget.addEventListener('click', saveTarget);
}

function updateModeLabel(mode) {
    const label = document.getElementById('fan-mode-label');
    if (!label) return;
    if (mode === 'manual') label.textContent = '✋ Manual';
    else if (mode === 'minerwatch') label.textContent = '🎯 AUTO (MinerWatch)';
    else label.textContent = '🤖 AUTO (firmware)';
}

async function applyManualFan() {
    const pct = parseInt(document.getElementById('ctl-fan-pct').value, 10);
    if (isNaN(pct)) { toast('Invalid value', 'error'); return; }
    try {
        await api(`/api/miners/${minerId}/control/fan_config`, {
            method: 'POST',
            body: { fan_mode: 'manual' },
        });
        await api(`/api/miners/${minerId}/control/fan`, {
            method: 'POST',
            body: { percent: pct },
        });
        updateModeLabel('manual');
        toast(`Fan set to ${pct}%`, 'success');
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

async function enableAutoFan() {
    // Reads the target temperature currently set in the field, saves to DB,
    // and activates minerwatch mode (server-side PID).
    const targetEl = document.getElementById('ctl-target');
    const target = targetEl ? parseFloat(targetEl.value) : NaN;
    if (isNaN(target)) {
        toast('Set the target temperature first', 'error');
        if (targetEl) targetEl.focus();
        return;
    }
    try {
        await api(`/api/miners/${minerId}/control/fan_config`, {
            method: 'POST',
            body: {
                fan_mode: 'minerwatch',
                auto_target_c: target,
            },
        });
        updateModeLabel('minerwatch');
        toast(`AUTO enabled — target ${target}°C`, 'success');
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

async function saveTarget() {
    const target = parseFloat(document.getElementById('ctl-target').value);
    if (isNaN(target)) { toast('Invalid target', 'error'); return; }
    try {
        await api(`/api/miners/${minerId}/control/fan_config`, {
            method: 'POST',
            body: { auto_target_c: target },
        });
        toast(`Target saved: ${target}°C`, 'success');
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

window.applyManualFan = applyManualFan;
window.enableAutoFan = enableAutoFan;
window.saveTarget = saveTarget;

window.sendControl = async (kind, payload) => {
    if (Object.values(payload).some((v) => isNaN(v))) {
        toast('Invalid value', 'error');
        return;
    }
    try {
        await api(`/api/miners/${minerId}/control/${kind}`, { method: 'POST', body: payload });
        toast('Command sent', 'success');
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
};

async function renderCharts() {
    const now = Math.floor(Date.now() / 1000);
    const from = now - currentRange;
    const data = await api(`/api/miners/${minerId}/metrics?from_ts=${from}&to_ts=${now}`);
    const points = data.metrics || [];

    const labels = points.map((p) => new Date(p.ts * 1000));
    const hashrate = points.map((p) => p.hashrate_ths);
    const tempChip = points.map((p) => p.temp_chip_c);
    const tempVr = points.map((p) => p.temp_vr_c);

    const baseOpts = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
            x: {
                type: 'time',
                time: { tooltipFormat: 'HH:mm', unit: pickUnit(currentRange) },
                ticks: { color: '#8b93a7' },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
                ticks: { color: '#8b93a7' },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
        },
        plugins: { legend: { labels: { color: '#e6e8ef' } } },
    };

    if (chartHash) chartHash.destroy();
    chartHash = new Chart(document.getElementById('chart-hashrate').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Hashrate (TH/s)',
                data: hashrate,
                borderColor: '#5db0ff',
                backgroundColor: 'rgba(93,176,255,0.12)',
                pointRadius: 0,
                tension: 0.25,
                fill: true,
            }],
        },
        options: baseOpts,
    });

    if (chartTemp) chartTemp.destroy();
    chartTemp = new Chart(document.getElementById('chart-temp').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Temp chip (°C)',
                    data: tempChip,
                    borderColor: '#fb923c',
                    backgroundColor: 'rgba(251,146,60,0.10)',
                    pointRadius: 0,
                    tension: 0.25,
                    fill: true,
                },
                {
                    label: 'Temp VR (°C)',
                    data: tempVr,
                    borderColor: '#facc15',
                    backgroundColor: 'transparent',
                    pointRadius: 0,
                    tension: 0.25,
                },
            ],
        },
        options: baseOpts,
    });
}

function pickUnit(seconds) {
    if (seconds <= 3600) return 'minute';
    if (seconds <= 86400) return 'hour';
    return 'day';
}
