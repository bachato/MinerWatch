// Service worker registration + Web Push subscription

(async () => {
    const stateEl = document.getElementById('push-state');

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (stateEl) stateEl.textContent = 'not supported';
        return;
    }

    let registration;
    try {
        registration = await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
        if (stateEl) stateEl.textContent = 'SW error';
        console.warn('SW register failed', err);
        return;
    }

    const sub = await registration.pushManager.getSubscription();
    if (sub) {
        if (stateEl) stateEl.textContent = 'active';
    } else {
        if (stateEl) {
            stateEl.innerHTML = `<a href="#" id="push-enable">enable</a>`;
            document.getElementById('push-enable').addEventListener('click', async (e) => {
                e.preventDefault();
                await enablePush(registration);
            });
        }
    }
})();

async function enablePush(registration) {
    const stateEl = document.getElementById('push-state');
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            stateEl.textContent = 'denied';
            return;
        }
        const { public_key } = await api('/api/push/vapid_public_key');
        const sub = await registration.pushManager.subscribe({
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
        stateEl.textContent = 'active';
        toast('Push notifications enabled', 'success');
    } catch (err) {
        toast(`Push error: ${err.message}`, 'error');
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str);
}
