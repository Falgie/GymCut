/* GymCut Service Worker */
const SW_VERSION = '1.2.6';
const CACHE_NAME = `gymcut-v${SW_VERSION}`;
const RUNTIME_CACHE = `gymcut-runtime-v${SW_VERSION}`;
const REST_TIMER_CACHE = 'gymcut-rest-timer-v1';
const REST_TIMER_URL = './__rest_timer_state__';
const REST_TIMER_TAG = 'gymcut-rest-timer';

const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './app-icon-mobile.png',
    './gymcut-logo.png',
    './header-logo.png',
    './streak-fire.webm',
    './streak-fire-fallback.mp4'
];

let restTimerFallbackTimeout = null;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE && key !== REST_TIMER_CACHE)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
            .then(() => checkStoredRestTimer())
    );
});

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'SCHEDULE_REST_TIMER') {
        event.waitUntil(scheduleRestTimerFromClient(data));
    } else if (data.type === 'CANCEL_REST_TIMER') {
        event.waitUntil(cancelRestTimerInternal({ clearStorage: true, closeNotifications: true }));
    } else if (data.type === 'CLEAR_REST_TIMER_STATE') {
        event.waitUntil(clearRestTimerStateOnly());
    } else if (data.type === 'PING_REST_TIMER') {
        event.waitUntil(checkStoredRestTimer());
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const isRest = event.notification && event.notification.tag === REST_TIMER_TAG;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            const tasks = [];
            if (isRest) {
                tasks.push(notifyOpenClients({ type: 'REST_TIMER_DUE' }));
            }
            for (const client of clientList) {
                if ('focus' in client) {
                    tasks.push(client.focus());
                    return Promise.all(tasks);
                }
            }
            if (self.clients.openWindow) {
                tasks.push(self.clients.openWindow('./'));
            }
            return Promise.all(tasks);
        })
    );
});

async function notifyOpenClients(message) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((client) => {
        try { client.postMessage(message); } catch (e) { /* ignore */ }
    });
}

async function saveRestTimerState(state) {
    const cache = await caches.open(REST_TIMER_CACHE);
    if (!state) {
        await cache.delete(REST_TIMER_URL);
        return;
    }
    await cache.put(
        REST_TIMER_URL,
        new Response(JSON.stringify(state), {
            headers: { 'Content-Type': 'application/json' }
        })
    );
}

async function loadRestTimerState() {
    try {
        const cache = await caches.open(REST_TIMER_CACHE);
        const res = await cache.match(REST_TIMER_URL);
        if (!res) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function clearRestTimerStateOnly() {
    if (restTimerFallbackTimeout) {
        clearTimeout(restTimerFallbackTimeout);
        restTimerFallbackTimeout = null;
    }
    await saveRestTimerState(null);
}

async function cancelRestTimerInternal({ clearStorage, closeNotifications }) {
    if (restTimerFallbackTimeout) {
        clearTimeout(restTimerFallbackTimeout);
        restTimerFallbackTimeout = null;
    }
    if (closeNotifications) {
        try {
            const triggered = await self.registration.getNotifications({
                tag: REST_TIMER_TAG,
                includeTriggered: true
            });
            triggered.forEach((n) => n.close());
        } catch (e) {
            try {
                const shown = await self.registration.getNotifications({ tag: REST_TIMER_TAG });
                shown.forEach((n) => n.close());
            } catch (e2) { /* ignore */ }
        }
    }
    if (clearStorage) await saveRestTimerState(null);
}

function supportsTimestampTrigger() {
    return typeof TimestampTrigger !== 'undefined' &&
        typeof Notification !== 'undefined' &&
        'showTrigger' in Notification.prototype;
}

async function showRestNotification(payload) {
    const title = payload.title || 'Rest time is over!';
    const opts = {
        body: payload.body || '',
        icon: payload.icon || 'app-icon-mobile.png',
        badge: payload.icon || 'app-icon-mobile.png',
        tag: REST_TIMER_TAG,
        renotify: true,
        silent: false,
        vibrate: [40, 60, 40],
        data: { type: 'rest-timer', endsAt: payload.endsAt || Date.now() }
    };
    await self.registration.showNotification(title, opts);
    await notifyOpenClients({ type: 'REST_TIMER_DUE', endsAt: payload.endsAt || Date.now() });
}

async function scheduleRestTimerFromClient(payload) {
    const endsAt = Number(payload.endsAt);
    if (!Number.isFinite(endsAt)) return;

    await cancelRestTimerInternal({ clearStorage: false, closeNotifications: true });

    const state = {
        endsAt,
        title: payload.title || 'Rest time is over!',
        body: payload.body || '',
        icon: payload.icon || 'app-icon-mobile.png'
    };
    await saveRestTimerState(state);

    const delay = endsAt - Date.now();
    if (delay <= 0) {
        await showRestNotification(state);
        await saveRestTimerState(null);
        return;
    }

    // Chrome/Android: zaplanuj powiadomienie na dokładny czas — działa mimo uśpionej karty.
    if (supportsTimestampTrigger()) {
        try {
            await self.registration.showNotification(state.title, {
                body: state.body,
                icon: state.icon,
                badge: state.icon,
                tag: REST_TIMER_TAG,
                renotify: true,
                silent: false,
                vibrate: [40, 60, 40],
                showTrigger: new TimestampTrigger(endsAt),
                data: { type: 'rest-timer', endsAt }
            });
            return;
        } catch (e) {
            // spadnij na fallback
        }
    }

    // Fallback: setTimeout w SW (działa, dopóki SW żyje) + stan w cache na wypadek restartu.
    restTimerFallbackTimeout = setTimeout(() => {
        restTimerFallbackTimeout = null;
        showRestNotification(state).then(() => saveRestTimerState(null));
    }, delay + 30);
}

async function checkStoredRestTimer() {
    const state = await loadRestTimerState();
    if (!state || !state.endsAt) return;
    const endsAt = Number(state.endsAt);
    if (!Number.isFinite(endsAt)) {
        await saveRestTimerState(null);
        return;
    }
    if (Date.now() >= endsAt) {
        let alreadyShown = false;
        try {
            const shown = await self.registration.getNotifications({ tag: REST_TIMER_TAG });
            alreadyShown = shown.length > 0;
        } catch (e) { /* ignore */ }
        if (!alreadyShown) {
            await showRestNotification(state);
        } else {
            await notifyOpenClients({ type: 'REST_TIMER_DUE', endsAt });
        }
        await saveRestTimerState(null);
        return;
    }
    // SW wstał wcześniej niż deadline — dopnij ponownie.
    await scheduleRestTimerFromClient(state);
}

function isNavigationRequest(request) {
    return request.mode === 'navigate' ||
        (request.destination === 'document') ||
        (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Przy każdym wejściu w appkę sprawdź, czy timer już minął w tle.
    if (isNavigationRequest(request)) {
        event.waitUntil(checkStoredRestTimer());
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put('./index.html', copy);
                    });
                    return response;
                })
                .catch(() =>
                    caches.match('./index.html').then((cached) => cached || caches.match('./'))
                )
        );
        return;
    }

    // Analityka — nie cachujemy.
    if (url.hostname.includes('umami.is')) return;

    // Cache-first z dogrywaniem do runtime cache (zasoby lokalne + CDN: Font Awesome, Google Fonts).
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (response && (response.ok || response.type === 'opaque')) {
                    const copy = response.clone();
                    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
                }
                return response;
            });
        })
    );
});
