const CACHE_NAME = 'ypwi-scanner-v5.0';
const ASSETS_TO_CACHE = [
    '/scanner.html',
    '/css/tailwind.css',
    '/js/jsQR.js',
    '/assets/images/icon.png',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// 1. Install Service Worker & Cache File Inti
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching sistem inti V5.0');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

// 2. Aktivasi & Pembersihan Cache Lama jika ada update V5.1 dst
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Menghapus Cache Lama:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. Strategi Network First, Fallback to Cache (Sangat cocok untuk Scanner yang butuh data realtime)
self.addEventListener('fetch', (event) => {
    // Abaikan request API (misal: POST ke /api/...)
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Cek apakah response valid
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback ke cache
                return caches.match(event.request);
            })
    );
});