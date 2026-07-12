/* GymCut Service Worker */
const SW_VERSION = '1.2.0';
const CACHE_NAME = `gymcut-v${SW_VERSION}`;
const RUNTIME_CACHE = `gymcut-runtime-v${SW_VERSION}`;

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
                    .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

function isNavigationRequest(request) {
    return request.mode === 'navigate' ||
        (request.destination === 'document') ||
        (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Network-first dla dokumentu HTML — aktualizacje aplikacji docierają od razu,
    // a offline serwujemy ostatnią zapisaną wersję.
    if (isNavigationRequest(request)) {
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
