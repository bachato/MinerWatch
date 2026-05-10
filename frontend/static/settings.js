// Settings page: loads config + stored overrides, saves, manages alerts and push notifications.

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadAlerts();
    await initPushUI();

    document.getElementById('btn-save').addEventListener('click', saveSettings);
    document.getElementById('btn-push-enable').addEventListener('click', enablePushFlow);
    document.getElementById('btn-push-test').addEventListener('click', sendTestPush);
    document.getElementById('btn-push-disable').addEventListener('click', disablePushFlow);
    document.getElementById('btn-push-purge').addEventListener('click', purgeAllPushSubs);
});

async function loadSettings() {
    const data = await api('/api/settings');
    const cur = data.current;
    document.getElementById('polling.interval_seconds').value = cur.polling.interval_seconds;
    document.getElementById('polling.request_timeout').value = cur.polling.request_timeout;
    if (cur.polling.hashrate_smoothing_seconds !== undefined) {
        document.getElementById('polling.hashrate_smoothing_seconds').value = cur.polling.hashrate_smoothing_seconds;
    }
    document.getElementById('storage.retention_days').value = cur.storage.retention_days;
    document.getElementById('alerts.temp_chip_threshold').value = cur.alerts.temp_chip_threshold;
    document.getElementById('alerts.temp_vr_threshold').value = cur.alerts.temp_vr_threshold;
    document.getElementById('alerts.offline_threshold_seconds').value = cur.alerts.offline_threshold_seconds;
    if (cur.alerts.repeat_seconds !== undefined) {
        document.getElementById('alerts.repeat_seconds').value = cur.alerts.repeat_seconds;
    }
    if (cur.alerts.notifications_enabled !== undefined) {
        document.getElementById('alerts.notifications_enabled').checked = !!cur.alerts.notifications_enabled;
    } else {
        // Default: active (backward compatibility with pre-feature DB)
        document.getElementById('alerts.notifications_enabled').checked = true;
    }
    document.getElementById('network.scan_cidr').value = cur.network.scan_cidr;
    document.getElementById('auth.enabled').checked = cur.auth_enabled;
    // password is never returned; field stays empty and user resets only if they want to change it
}

async function saveSettings() {
    const overrides = {
        'polling.interval_seconds': document.getElementById('polling.interval_seconds').value,
        'polling.request_timeout': document.getElementById('polling.request_timeout').value,
        'polling.hashrate_smoothing_seconds': document.getElementById('polling.hashrate_smoothing_seconds').value,
        'storage.retention_days': document.getElementById('storage.retention_days').value,
        'alerts.temp_chip_threshold': document.getElementById('alerts.temp_chip_threshold').value,
        'alerts.temp_vr_threshold': document.getElementById('alerts.temp_vr_threshold').value,
        'alerts.offline_threshold_seconds': document.getElementById('alerts.offline_threshold_seconds').value,
        'alerts.repeat_seconds': document.getElementById('alerts.repeat_seconds').value,
        'alerts.notifications_enabled': document.getElementById('alerts.notifications_enabled').checked,
        'network.scan_cidr': document.getElementById('network.scan_cidr').value,
        'auth.enabled': document.getElementById('auth.enabled').checked,
    };
    const pwd = document.getElementById('auth.password').value;
    if (pwd) overrides['auth.password'] = pwd;
    try {
        await api('/api/settings', { method: 'POST', body: { overrides } });
        toast('Settings saved', 'success');
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

async function loadAlerts() {
    const { alerts } = await api('/api/alerts?limit=50');
    const el = document.getElementById('alerts-list');
    if (!alerts.length) { el.innerHTML = '<div class="subtitle">No alerts</div>'; return; }
    el.innerHTML = `
        <table>
            <tr><th>When</th><th>Severity</th><th>Code</th><th>Message</th><th></th></tr>
            ${alerts.map((a) => `
                <tr>
                    <td>${new Date(a.ts * 1000).toLocaleString()}</td>
                    <td><span class="status-dot ${a.severity === 'critical' ? 'offline' : a.severity === 'warning' ? 'warning' : 'online'}"></span>${a.severity}</td>
                    <td>${a.code}</td>
                    <td>${escapeHtml(a.message)}</td>
                    <td>${a.acknowledged ? '✓' : `<button onclick="ackAlert(${a.id})">Ack</button>`}</td>
                </tr>
            `).join('')}
        </table>
    `;
}

window.ackAlert = async (id) => {
    await api(`/api/alerts/${id}/ack`, { method: 'POST' });
    await loadAlerts();
};

// ---------- Push notifications ----------

let _swReg = null;

async function initPushUI() {
    const detail = document.getElementById('push-state-detail');
    const btnEnable = document.getElementById('btn-push-enable');
    const btnTest = document.getElementById('btn-push-test');
    const btnDisable = document.getElementById('btn-push-disable');

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        detail.textContent = '❌ your browser does not support Web Push';
        btnEnable.disabled = true;
        btnTest.disabled = true;
        btnDisable.disabled = true;
        return;
    }

    if (Notification.permission === 'denied') {
        detail.innerHTML = '🚫 you blocked notifications for this site. Unblock from chrome://settings/content/notifications or the lock icon in the address bar.';
        btnEnable.disabled = true;
        btnTest.disabled = true;
        return;
    }

    try {
        _swReg = await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
        detail.textContent = `❌ service worker registration error: ${err.message}`;
        return;
    }

    const sub = await _swReg.pushManager.getSubscription();
    if (sub) {
        detail.innerHTML = '✅ <strong>active</strong> · you can receive notifications';
        btnEnable.style.display = 'none';
        btnDisable.style.display = '';
        btnTest.style.display = '';
    } else {
        const permLabel = Notification.permission === 'granted'
            ? 'permission granted but not subscribed'
            : 'not yet authorized';
        detail.innerHTML = `⚪ <strong>inactive</strong> · ${permLabel}. Click "Enable notifications" below.`;
        btnDisable.style.display = 'none';
        btnTest.style.display = 'none';
    }
}

async function enablePushFlow() {
    const detail = document.getElementById('push-state-detail');
    if (!_swReg) {
        try {
            _swReg = await navigator.serviceWorker.register('/sw.js');
        } catch (err) {
            toast(`SW error: ${err.message}`, 'error');
            return;
        }
    }
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            detail.textContent = '🚫 permission denied';
            toast('You denied permission. To re-enable: chrome://settings/content/notifications', 'error', 6000);
            return;
        }
        const { public_key } = await api('/api/push/vapid_public_key');
        const sub = await _swReg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(public_key),
        });
        await api('/api/push/subscribe', {
            method: 'POST',
            body: {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
                    auth: arrayBufferToBase64(sub.getKey('auth')),
                },
            },
        });
        toast('Notifications enabled', 'success');
        await initPushUI();
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

async function sendTestPush() {
    try {
        const r = await api('/api/push/test', { method: 'POST' });
        toast(`Test sent to ${r.subscribers} subscriber(s) — check your system notifications`, 'success', 5000);
    } catch (err) {
        toast(`Test error: ${err.message}`, 'error');
    }
}

async function disablePushFlow() {
    if (!_swReg) return;
    const sub = await _swReg.pushManager.getSubscription();
    if (sub) {
        await api('/api/push/subscribe', {
            method: 'DELETE',
            body: { endpoint: sub.endpoint },
        });
        await sub.unsubscribe();
    }
    toast('Notifications disabled (on this browser)', 'info');
    await initPushUI();
}

async function purgeAllPushSubs() {
    if (!confirm('Remove ALL push subscriptions from the server? All devices/tabs that receive notifications will stop. Are you sure?')) {
        return;
    }
    try {
        const r = await api('/api/push/subscriptions/all', { method: 'DELETE' });
        // Also clean up the local subscription on this browser
        if (_swReg) {
            const sub = await _swReg.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
        }
        toast(`Removed ${r.removed} subscriptions from the server`, 'success');
        await initPushUI();
    } catch (err) {
        toast(`Error: ${err.message}`, 'error');
    }
}

// helpers (duplicated from push.js for settings page independence)
function urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const std = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(std);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
