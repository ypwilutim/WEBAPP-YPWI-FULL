/**
 * Auth Manager untuk YPWI Scanner (V5.0)
 * Mengelola IndexedDB untuk persistensi data di iPhone
 */

const DB_NAME = "YPWI_Scanner_DB";
const STORE_NAME = "auth";

// 1. Membuka koneksi ke Database
const openDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "key" });
            }
        };

        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject("Gagal membuka DB: " + e.target.error);
    });
};

// 2. Fungsi untuk Menyimpan Data (Contoh: simpan('reg_token', 'ABC123'))
async function simpanKeDB(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({ key, value });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject("Gagal menyimpan data");
    });
}

// 3. Fungsi untuk Mengambil Data (Contoh: let token = await ambilDariDB('reg_token'))
async function ambilDariDB(key) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
    });
}