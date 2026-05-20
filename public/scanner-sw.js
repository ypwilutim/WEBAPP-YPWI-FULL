const CACHE_NAME = 'ypwi-scanner-v5.0';
const ASSETS_TO_CACHE = [
    '/scanner.html',
    '/css/tailwind.css',
    '/js/jsQR.js',
    '/assets/images/YPWI LOGO HITAM.png',
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
    // Lewati request eksternal / API backend agar tidak merusak pengiriman data absensi
    if (!event.request.url.startsWith(self.location.origin) && !event.request.url.includes('cdnjs.cloudflare.com')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Jika sukses dapet jaringan, duplikat hasilnya ke cache terbaru
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Jika offline / jaringan gagal, ambil langsung dari cache lokal
                return caches.match(event.request);
            })
    );
});