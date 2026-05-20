const CACHE_NAME = 'ypwi-absensi-v1';
const ASSETS = [
    'scanner.html',
    'https://unpkg.com/dexie/dist/dexie.js',
    // tambahkan file CSS/JS lain Anda di sini
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});