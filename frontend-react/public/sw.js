// MinerWatch service worker — Web Push management

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    console.log('[MinerWatch SW] push received', event.data ? event.data.text() : '(empty)');
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) {
        payload = { title: 'MinerWatch', body: event.data ? event.data.text() : '' };
    }
    const title = payload.title || 'MinerWatch';
    const opts = {
        body: payload.body || '',
        icon: '/static/favicon.svg',
        badge: '/static/favicon.svg',
        // Each notification has a unique tag so they don't override in sequence.
        tag: `mw-${payload.miner_id || 'general'}-${Date.now()}`,
        renotify: true,
        requireInteraction: false,
        data: payload,
    };
    event.waitUntil(
        self.registration.showNotification(title, opts).catch((err) => {
            console.error('[MinerWatch SW] showNotification failed', err);
        }),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const minerId = event.notification.data && event.notification.data.miner_id;
    const url = minerId ? `/miner/${minerId}` : '/';
    event.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
        for (const c of cs) {
            if (c.url.endsWith(url) && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
    }));
});
