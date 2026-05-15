/**
 * Scanner App - QR-based Attendance System
 * Using jsQR for direct QR decoding (more reliable)
 */

// Simple test to ensure JS is loaded
console.log('[SCANNER] scanner-app.js loaded successfully!');
console.log('[SCANNER] Current URL:', window.location.href);
console.log('[SCANNER] User Agent:', navigator.userAgent);

(function() {
  'use strict';

  // ==================== CONFIGURATION ====================
  const CONFIG = {
    API_BASE: '/api',
    DB_NAME: 'scanner-attendance-db',
    DB_VERSION: 1,
    STORES: {
      QUEUE: 'attendance-queue',
      DEVICE: 'registered-device'
    },
    QR_SCAN_COOLDOWN: 3000,
    SYNC_RETRY_ATTEMPTS: 3,
    AUTO_SYNC_INTERVAL: 30000,
    SCAN_INTERVAL: 50, // Reduced from 100ms for faster scanning
    MAX_RETRY_AGE: 24 * 60 * 60 * 1000 // 24 hours max retry age
  };

  // ==================== STATE ====================
  let state = {
    isOnline: navigator.onLine,
    stream: null,
    isScanning: false,
    deviceRegistered: false,
    deviceInfo: null,
    pendingCount: 0,
    lastScanTime: {},
    schoolList: [],
    isProcessingScan: false,
    processingScans: {}, // Per-scan_id processing tracker - replaces global blocking
    scanAnimationFrame: null,
    currentFacingMode: 'environment' // Track current camera
  };

  // ==================== INDEXEDDB ====================
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CONFIG.STORES.QUEUE)) {
        const queueStore = db.createObjectStore(CONFIG.STORES.QUEUE, { keyPath: 'id', autoIncrement: true });
        queueStore.createIndex('timestamp', 'timestamp', { unique: false });
        queueStore.createIndex('syncStatus', 'syncStatus', { unique: false });
        queueStore.createIndex('scanId', 'scanId', { unique: false });
      }
      if (!db.objectStoreNames.contains(CONFIG.STORES.DEVICE)) {
        const deviceStore = db.createObjectStore(CONFIG.STORES.DEVICE, { keyPath: 'device_id' });
        deviceStore.createIndex('status', 'status', { unique: false });
      }
    };
  });

  // ==================== DATABASE OPERATIONS ====================
  async function dbTransaction(storeName, mode, callback) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const request = callback(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function addToQueue(item) {
    const id = await dbTransaction(CONFIG.STORES.QUEUE, 'readwrite', (store) => {
      return store.add(item);
    });
    updatePendingCount();
    return id;
  }

  async function getPendingItems() {
    return await dbTransaction(CONFIG.STORES.QUEUE, 'readonly', (store) => {
      return store.getAll();
    });
  }

  async function deleteFromQueue(id) {
    return await dbTransaction(CONFIG.STORES.QUEUE, 'readwrite', (store) => {
      return store.delete(id);
    });
  }

  async function getDeviceInfo() {
    try {
      const devices = await dbTransaction(CONFIG.STORES.DEVICE, 'readonly', (store) => {
        return store.getAll();
      });
      return devices.length > 0 ? devices[0] : null;
    } catch (error) {
      console.error('[DB] Error getting device:', error);
      return null;
    }
  }

  async function saveDeviceInfo(device) {
    return await dbTransaction(CONFIG.STORES.DEVICE, 'readwrite', (store) => {
      return store.put(device);
    });
  }

  // ==================== UI UTILITIES ====================
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const bgColor = {
      success: 'bg-green-600',
      error: 'bg-red-600',
      warning: 'bg-yellow-600',
      info: 'bg-blue-600'
    }[type] || 'bg-gray-600';

    toast.className = `${bgColor} text-white px-4 py-3 rounded-lg shadow-lg mb-2 transition-all transform translate-y-0 opacity-100`;
    toast.innerHTML = `
      <div class="flex items-center space-x-2">
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
        <span>${message}</span>
      </div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function updateNetworkStatus() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const syncBtn = document.getElementById('sync-btn');

    state.isOnline = navigator.onLine;

    if (state.isOnline) {
      statusDot.className = 'status-dot status-online';
      statusText.textContent = 'Online';
      if (syncBtn) syncBtn.disabled = false;
      attemptSync();
    } else {
      statusDot.className = 'status-dot status-offline';
      statusText.textContent = 'Offline';
      if (syncBtn) syncBtn.disabled = true;
    }
  }

  function updatePendingCount() {
    getPendingItems().then(items => {
      state.pendingCount = items.filter(i => i.syncStatus === 'pending').length;
      const badge = document.getElementById('pending-badge');
      if (badge) {
        if (state.pendingCount > 0) {
          badge.textContent = state.pendingCount;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }
      const indicator = document.getElementById('offline-queue-indicator');
      if (indicator) {
        if (state.pendingCount > 0 && !state.isOnline) {
          document.getElementById('queue-count').textContent = state.pendingCount;
          indicator.classList.remove('hidden');
        } else {
          indicator.classList.add('hidden');
        }
      }
    });
  }

  function updateScanningStatus(msg) {
    const el = document.getElementById('scanning-status');
    if (el) el.textContent = 'Status: ' + msg;
  }

  function playBeep() {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.frequency.value = 1000;
      oscillator.type = 'sine';
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch (error) {
      console.log('[AUDIO] Beep not available');
    }
  }

  // ==================== CAMERA & QR SCANNING ====================
  async function initScanner() {
    if (typeof jsQR === 'undefined') {
      console.error('[SCANNER] jsQR library not loaded');
      showToast('Scanner library tidak dimuat.', 'error');
      return;
    }

    const videoEl = document.getElementById('reader');
    if (!videoEl) {
      console.error('[SCANNER] Video element not found');
      return;
    }

    // Stop any existing stream
    stopScanner();

    try {
// Request camera with optimal settings for QR scanning
       const constraints = {
         video: {
           facingMode: state.currentFacingMode,
           width: { ideal: 1920, max: 1920 },
           height: { ideal: 1080, max: 1080 },
           focusMode: 'continuous',
           exposureMode: 'continuous'
         },
         audio: false
       };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.stream = stream;
      videoEl.srcObject = stream;

      // Apply camera settings for better low-light performance
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities();

// Try to enable low-light boost if supported
       if ('lowLightBoost' in capabilities) {
         try {
           await videoTrack.applyConstraints({ advanced: [{ lowLightBoost: true }] });
           console.log('[SCANNER] Low light boost enabled');
         } catch (e) {
           console.log('[SCANNER] Low light boost not available');
         }
       }

       // Apply mirror transform for front camera
       if (state.currentFacingMode === 'user') {
         videoEl.style.transform = 'scaleX(-1)';
         videoEl.style.webkitTransform = 'scaleX(-1)';
       }

      // Set exposure and focus manually if supported
      if ('exposureCompensation' in capabilities) {
        const minExp = capabilities.exposureCompensation.min;
        const maxExp = capabilities.exposureCompensation.max;
        // Increase exposure by 1-2 stops for low light
        const targetExp = Math.min(maxExp, Math.max(minExp + 1.5, 0));
        try {
          await videoTrack.applyConstraints({ advanced: [{ exposureCompensation: targetExp }] });
          console.log('[SCANNER] Exposure compensation set to:', targetExp);
        } catch (e) {
          console.log('[SCANNER] Could not set exposure compensation');
        }
      }

      await new Promise((resolve) => {
        videoEl.onloadedmetadata = () => {
          videoEl.play();
          resolve();
        };
      });

      state.isScanning = true;
      console.log('[SCANNER] Camera started');
      showToast('Scanner siap. Arahkan QR code.', 'info', 4000);

      // Start QR detection loop
      state.scanAnimationFrame = requestAnimationFrame(scanLoop);

    } catch (err) {
      console.error('[SCANNER] Camera access failed:', err);

      // Fallback: try user (front) camera with basic settings
      try {
        const fallbackConstraints = {
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        };

        const fallbackStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        state.stream = fallbackStream;
        videoEl.srcObject = fallbackStream;

        await new Promise((resolve) => {
          videoEl.onloadedmetadata = () => {
            videoEl.play();
            resolve();
          };
        });

        state.isScanning = true;
        console.log('[SCANNER] Camera started (front)');
        showToast('Scanner siap (front camera)', 'warning', 4000);
        state.scanAnimationFrame = requestAnimationFrame(scanLoop);

      } catch (fallbackErr) {
        console.error('[SCANNER] All camera attempts failed:', fallbackErr);
        showToast('Gagal mengakses kamera: ' + fallbackErr.message, 'error');
        state.isScanning = false;
      }
    }
  }

   function stopScanner() {
     if (state.scanAnimationFrame) {
       cancelAnimationFrame(state.scanAnimationFrame);
       state.scanAnimationFrame = null;
     }

     if (state.stream) {
       state.stream.getTracks().forEach(track => track.stop());
       state.stream = null;
     }

     const videoEl = document.getElementById('reader');
     if (videoEl) {
       videoEl.srcObject = null;
     }

     state.isScanning = false;
   }

  function scanLoop() {
    if (!state.isScanning) return;

    const videoEl = document.getElementById('reader');
    if (!videoEl || videoEl.readyState !== 4) {
      state.scanAnimationFrame = requestAnimationFrame(scanLoop);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      // Use full video resolution for quality
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      context.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      let imageData = context.getImageData(0, 0, canvas.width, canvas.height);

      // Optional: Crop to center ROI (80% of frame) for speed + focus
      // Uncomment if needed for performance on large frames
      // imageData = cropToCenter(imageData, 0.8);

      // Preprocess: enhance contrast, handle backlight
      const processedData = preprocessImage(imageData);

      // Try both normal and inverted QR codes
      // increase chance with multiple decoding attempts on slightly different preprocessing
      let code = jsQR(processedData.data, processedData.width, processedData.height, {
        inversionAttempts: 'attemptBoth'
      });

      // If not found, try with lighter preprocessing (more tolerant for blurry/backlit)
      if (!code) {
        const lighterData = preprocessImageLight(imageData);
        code = jsQR(lighterData.data, lighterData.width, lighterData.height, {
          inversionAttempts: 'attemptBoth'
        });
      }

      if (code && code.data) {
        handleQRDetected(code.data);
      }
    } catch (err) {
      console.error('[SCAN] Error processing frame:', err);
    }

    state.scanAnimationFrame = requestAnimationFrame(scanLoop);
  }

  // Crop image to center ROI (optional optimization)
  function cropToCenter(imageData, ratio = 0.8) {
    const { width, height, data } = imageData;
    const cropW = Math.floor(width * ratio);
    const cropH = Math.floor(height * ratio);
    const startX = Math.floor((width - cropW) / 2);
    const startY = Math.floor((height - cropH) / 2);

    const cropped = new Uint8ClampedArray(cropW * cropH * 4);
    let dstIdx = 0;

    for (let y = startY; y < startY + cropH; y++) {
      for (let x = startX; x < startX + cropW; x++) {
        const srcIdx = (y * width + x) * 4;
        cropped[dstIdx++] = data[srcIdx];
        cropped[dstIdx++] = data[srcIdx + 1];
        cropped[dstIdx++] = data[srcIdx + 2];
        cropped[dstIdx++] = data[srcIdx + 3];
      }
    }

     return new ImageData(cropped, cropW, cropH);
   }

  // Preprocess image for better QR detection in challenging lighting
  function preprocessImage(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const processed = new Uint8ClampedArray(data.length);

    // Adaptive histogram equalization approach for better contrast
    let minLum = 255;
    let maxLum = 0;

    // Pass 1: Calculate min/max luminance
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Perceptual luminance formula
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const lumRange = maxLum - minLum || 1;

    // Pass 2: Contrast stretching + adaptive threshold
    // Adaptive threshold: use 20-30% percentile as threshold for bimodal distribution
    let thresholdSum = 0;
    let pixelCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      thresholdSum += lum;
      pixelCount++;
    }

    const avgLum = thresholdSum / pixelCount;
    // Dynamic threshold: weighted between fixed 128 and average luminance
    const dynamicThreshold = 128 + (avgLum - 128) * 0.5;

    // Pass 3: Apply contrast stretch and threshold
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      // Contrast stretch to 0-255
      let stretched = ((lum - minLum) / lumRange) * 255;
      stretched = Math.max(0, Math.min(255, stretched));

      // Adaptive threshold
      const binary = stretched > dynamicThreshold ? 255 : 0;

      processed[i] = binary;
      processed[i + 1] = binary;
      processed[i + 2] = binary;
      processed[i + 3] = a;
    }

    return new ImageData(processed, width, height);
  }

  // Lighter preprocessing (less contrast) for backlit/blurry conditions
  function preprocessImageLight(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const processed = new Uint8ClampedArray(data.length);

    // Simple gamma correction for lifting shadows
    const gamma = 1.2; // >1 = brighter, <1 = darker

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Apply gamma
      const rG = Math.pow(r / 255, gamma) * 255;
      const gG = Math.pow(g / 255, gamma) * 255;
      const bG = Math.pow(b / 255, gamma) * 255;

      // Grayscale
      const lum = 0.2126 * rG + 0.7152 * gG + 0.0722 * bG;

      // Lower threshold for gamma-corrected (brighter shadows)
      const binary = lum > 100 ? 255 : 0;

      processed[i] = binary;
      processed[i + 1] = binary;
      processed[i + 2] = binary;
      processed[i + 3] = a;
    }

     return new ImageData(processed, width, height);
   }

async function handleQRDetected(decodedText) {
     updateScanningStatus('✅ QR Terdeteksi!');
     console.log('[SCAN] Raw text:', decodedText);

     const now = Date.now();
     const raw = decodedText.trim();
     let qrData;

     // If raw is all digits (legacy numeric ID), treat as raw string (avoid JSON.parse number precision loss)
     if (/^\d+$/.test(raw)) {
       console.log('[SCAN] Numeric ID format (legacy)');
       qrData = { scan_id: raw };
     } else {
       try {
         const parsed = JSON.parse(raw);
         if (typeof parsed === 'object' && parsed !== null) {
           qrData = parsed;
         } else {
           console.log('[SCAN] Primitive JSON value');
           qrData = { scan_id: String(parsed) };
         }
       } catch (e) {
         console.log('[SCAN] Non-JSON text (legacy)');
         qrData = { scan_id: raw };
       }
     }

     console.log('[SCAN] Parsed qrData:', qrData);
     updateScanningStatus('✅ Memproses...');

// Fill missing fields for legacy/partial data
      if (!qrData.timestamp) qrData.timestamp = new Date().toISOString();
      if (!qrData.tenant_id) qrData.tenant_id = state.deviceInfo ? state.deviceInfo.tenant_id : 'unknown';
      if (!qrData.signature) qrData.signature = 'legacy-' + qrData.scan_id;

      // Auto-detect masuk/pulang if not specified
      if (!qrData.type && state.isOnline && state.deviceRegistered) {
        try {
          const statusResponse = await fetch(`${CONFIG.API_BASE}/scanner/check-status?scan_id=${qrData.scan_id}`);
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            if (statusData.has_masuk && !statusData.has_pulang) {
              qrData.type = 'pulang';
              showToast('Auto: Absen Pulang', 'info', 2000);
            } else if (!statusData.has_masuk) {
              qrData.type = 'masuk';
            }
          }
        } catch (e) {
          console.log('[SCAN] Could not check status, defaulting to masuk');
          qrData.type = 'masuk';
        }
      } else if (!qrData.type) {
        qrData.type = 'masuk';
      }

     // Non-blocking: Check cooldown per scan_id only
     const scanId = qrData.scan_id;
     if (state.lastScanTime[scanId] && (now - state.lastScanTime[scanId] < CONFIG.QR_SCAN_COOLDOWN)) {
       showToast(`Absensi ${scanId} sudah dicatat`, 'warning');
       delete state.processingScans[scanId]; // Cleanup
       updateScanningStatus('Status: Menunggu QR...');
       return;
     }
     // Per-scan_id processing check (non-blocking)
     if (state.processingScans[scanId]) {
       console.log('[SCAN] Skipping - already processing:', scanId);
       return;
     }
     state.processingScans[scanId] = true;
     state.lastScanTime[scanId] = now;

     // Check expiry if provided
     if (qrData.expiry && new Date(qrData.expiry) < new Date()) {
       showToast('QR code sudah kadaluwarsa', 'error');
       delete state.processingScans[scanId]; // Cleanup
       updateScanningStatus('Status: Menunggu QR...');
       return;
     }

     playBeep();
     if (navigator.vibrate) navigator.vibrate(200);

     processAttendance(qrData).finally(() => {
       delete state.processingScans[scanId]; // Cleanup after processing
     });
   }

   // ==================== ATTENDANCE PROCESSING ====================
async function processAttendance(qrData) {
     const scanTimestamp = new Date().toISOString();
     const attendanceData = {
       scan_id: qrData.scan_id,
       timestamp: scanTimestamp,
       type: qrData.type === 'pulang' ? 'pulang' : 'masuk',
       device_id: state.deviceInfo ? state.deviceInfo.device_id : 'unknown',
       tenant_id: qrData.tenant_id,
       signature: qrData.signature,
       expiry: qrData.expiry || null,
       offline_validated: !state.isOnline,
       syncStatus: state.isOnline ? 'synced' : 'pending',
       createdAt: new Date().toISOString()
     };

     if (state.isOnline && state.deviceRegistered) {
       try {
         const response = await fetch(`${CONFIG.API_BASE}/scanner/attendance`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(attendanceData)
         });

         const result = await response.json();
         if (response.ok && result.success) {
           console.log(`[SCANNER] Attendance recorded: ${qrData.scan_id}`);
           showToast(`Absen ${qrData.type === 'pulang' ? 'Pulang' : 'Masuk'} - ${qrData.scan_id} BERHASIL`, 'success', 5000);
           updateScanningStatus('✅ Berhasil! Menunggu QR berikutnya...');
           setTimeout(() => updateScanningStatus('Status: Menunggu QR...'), 2000);
           return;
         } else {
           console.error('[SCANNER] Server rejected:', result.message);
           showToast(`Gagal: ${result.message || 'Unknown error'}`, 'error', 5000);
           updateScanningStatus('Status: Menunggu QR...');
         }
       } catch (error) {
         console.error('[SCANNER] Network error:', error);
         showToast('Network error: ' + error.message, 'error', 5000);
         updateScanningStatus('Status: Menunggu QR...');
       }
     } else {
       await addToQueue(attendanceData);
       showToast(`Offline - Data ${qrData.scan_id} disimpan lokal`, 'warning', 5000);
       updateScanningStatus('✅ Offline - Data tersimpan');
       setTimeout(() => updateScanningStatus('Status: Menunggu QR...'), 2000);
     }
   }

// ==================== SYNC ====================
   async function attemptSync() {
     if (!state.isOnline || !state.deviceRegistered) return;

     const pending = await getPendingItems();
     const toSync = pending.filter(item => item.syncStatus === 'pending');

     if (toSync.length === 0) return;

     console.log(`[SYNC] Attempting to sync ${toSync.length} items`);

     for (const item of toSync) {
       // Skip very old items (older than 24 hours)
       const itemAge = Date.now() - new Date(item.createdAt).getTime();
       if (itemAge > CONFIG.MAX_RETRY_AGE) {
         console.log('[SYNC] Skipping old item:', item.scan_id);
         continue;
       }

       try {
         const response = await fetch(`${CONFIG.API_BASE}/scanner/attendance`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             scan_id: item.scan_id,
             timestamp: item.timestamp,
             type: item.type,
             device_id: item.device_id,
             signature: item.signature,
             offline_validated: item.offline_validated,
             expiry: item.expiry
           })
         });

         const result = await response.json();
         if (response.ok && result.success) {
           await deleteFromQueue(item.id);
           console.log(`[SYNC] Synced: ${item.scan_id}`);
           showToast(`Synced: ${item.scan_id}`, 'success', 1500);
         } else {
           console.error(`[SYNC] Failed: ${item.scan_id}`, result.message);
         }
       } catch (error) {
         console.error(`[SYNC] Error: ${item.scan_id}`, error.message);
       }
     }

     updatePendingCount();
   }

   // ==================== BACKGROUND SYNC ====================
   async function registerBackgroundSync() {
     if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
       console.log('[SW] Background sync not supported');
       return;
     }

     try {
       const registration = await navigator.serviceWorker.ready;
       console.log('[SW] Ready for background sync');

       // Register sync event
       if ('sync' in registration) {
         try {
           await registration.sync.register('sync-attendance');
           console.log('[SW] Background sync registered');
         } catch (syncError) {
           console.log('[SW] Sync registration failed:', syncError);
         }
       }
     } catch (error) {
       console.log('[SW] Service worker not ready:', error);
     }
   }

  // ==================== DEVICE REGISTRATION ====================
  async function loadDeviceInfo() {
    const device = await getDeviceInfo();
    if (device) {
      state.deviceRegistered = true;
      state.deviceInfo = device;
      const schoolNameEl = document.getElementById('school-name');
      if (schoolNameEl) schoolNameEl.textContent = device.school_name;
      console.log('[DEVICE] Loaded from DB:', device);
      return true;
    }
    return false;
  }

  async function registerDevice(deviceData) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/scanner/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: deviceData.device_id,
          tenant_id: deviceData.tenant_id,
          school_name: deviceData.school_name,
          device_name: deviceData.device_name
        })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        const deviceToSave = {
          device_id: result.data.device_id,
          tenant_id: result.data.tenant_id,
          school_name: result.data.school_name,
          secret_key: result.data.secret_key,
          device_name: result.data.device_name,
          status: 'active',
          registered_at: new Date().toISOString()
        };
        await saveDeviceInfo(deviceToSave);
        state.deviceRegistered = true;
        state.deviceInfo = deviceToSave;

        document.getElementById('setup-modal').classList.add('hidden');
        const schoolNameEl = document.getElementById('school-name');
        if (schoolNameEl) schoolNameEl.textContent = deviceData.school_name;
        showToast('Device berhasil didaftarkan!', 'success');
        console.log('[DEVICE] Registered successfully');
        initScanner();
        return true;
      } else {
        showToast(result.message || 'Gagal mendaftarkan device', 'error');
        return false;
      }
    } catch (error) {
      console.error('[DEVICE] Registration error:', error);
      showToast('Network error during registration', 'error');
      return false;
    }
  }

  // ==================== UTILITY ====================
  function loadJsQR() {
    return new Promise((resolve, reject) => {
      if (typeof jsQR !== 'undefined') {
        resolve();
        return;
      }

      const cdnList = [
        'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
        'https://unpkg.com/jsqr@1.4.0/dist/jsQR.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jsqr/1.4.0/jsQR.min.js'
      ];

      let currentIndex = 0;

      function tryLoadNext() {
        if (currentIndex >= cdnList.length) {
          reject(new Error('All CDN attempts failed'));
          return;
        }

        const script = document.createElement('script');
        script.src = cdnList[currentIndex];
        script.onload = () => {
          console.log(`[SCANNER] jsQR loaded from CDN ${currentIndex + 1}`);
          resolve();
        };
        script.onerror = () => {
          console.log(`[SCANNER] CDN ${currentIndex + 1} failed, trying next...`);
          currentIndex++;
          tryLoadNext();
        };
        document.head.appendChild(script);
      }

      tryLoadNext();

      // Timeout
      setTimeout(() => {
        if (typeof jsQR === 'undefined') {
          reject(new Error('jsQR load timeout'));
        }
      }, 15000);
    });
  }

  // ==================== MOBILE DEBUG LOGGING ====================
  async function sendClickLog(buttonName) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/log-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          button: buttonName,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
          url: window.location.href
        })
      });

      if (response.ok) {
        console.log(`[LOG] ${buttonName} click logged to server`);
      } else {
        console.warn(`[LOG] Failed to log ${buttonName} click`);
      }
    } catch (error) {
      console.warn(`[LOG] Error logging ${buttonName} click:`, error.message);
    }
  }

  // ==================== PWA REFRESH & VERSIONING ====================
  function forceAppRefresh() {
    console.log('[PWA] Force refreshing app...');
    console.log('[PWA] Service worker available:', 'serviceWorker' in navigator);
    console.log('[PWA] Caches available:', 'caches' in window);
    showToast('Memuat ulang aplikasi...', 'info');

    // Force service worker update
    if ('serviceWorker' in navigator) {
      console.log('[PWA] Updating service workers...');
      navigator.serviceWorker.getRegistrations().then(registrations => {
        console.log('[PWA] Found', registrations.length, 'service workers');
        registrations.forEach(registration => {
          registration.update();
        });
      });

      // Send message to service worker for cache busting
      if (navigator.serviceWorker.controller) {
        console.log('[PWA] Sending FORCE_REFRESH message to service worker');
        navigator.serviceWorker.controller.postMessage({ type: 'FORCE_REFRESH' });
      } else {
        console.warn('[PWA] No service worker controller available');
      }
    } else {
      console.warn('[PWA] Service Worker not supported');
    }

    // Clear caches
    if ('caches' in window) {
      console.log('[PWA] Clearing browser caches...');
      caches.keys().then(names => {
        console.log('[PWA] Found caches, clearing...');
        names.forEach(name => {
          console.log('[PWA] Deleting cache:', name);
          caches.delete(name);
        });
      });
    } else {
      console.warn('[PWA] Cache API not supported');
    }

    // Hard refresh after short delay
    console.log('[PWA] Scheduling hard refresh in 1 second...');
    setTimeout(() => {
      console.log('[PWA] Executing hard refresh');
      window.location.reload(true);
    }, 1000);
  }

  function checkForUpdates() {
    if (!navigator.onLine) return;

    fetch(`${CONFIG.API_BASE}/version`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data) return;

        const currentVersion = localStorage.getItem('app_version') || '1.0.0';
        if (currentVersion !== data.version) {
          showToast(`Update ${data.version} tersedia! Klik refresh untuk update.`, 'info', 15000);
          localStorage.setItem('app_version', data.version);
        }
      })
      .catch(err => {
        console.log('[VERSION] Check failed:', err.message);
      });
  }

  function initIOSHandling() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isIOS) {
      console.log('[iOS] iOS device detected, enabling iOS-specific handling');

      // Force refresh every hour to prevent stale cache
      setInterval(() => {
        if (document.hidden) return; // Don't refresh if tab not active
        console.log('[iOS] Hourly refresh');
        window.location.reload(true);
      }, 60 * 60 * 1000);

      // Add iOS-specific cache busting
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data && event.data.type === 'CACHE_BUST') {
            forceAppRefresh();
          }
        });
      }
    }
  }

  // ==================== INITIALIZATION ====================
  async function init() {
    console.log('[SCANNER] Initializing...');
    console.log('[INIT] DOM ready:', document.readyState);
    console.log('[INIT] Service worker supported:', 'serviceWorker' in navigator);
    console.log('[INIT] Caches API supported:', 'caches' in window);

     // Test DOM elements exist
     console.log('[INIT] Testing DOM elements:');
     console.log('[INIT] - torch-btn:', !!document.getElementById('torch-btn'));
     console.log('[INIT] - switch-camera-btn:', !!document.getElementById('switch-camera-btn'));
     console.log('[INIT] - force-refresh-btn:', !!document.getElementById('force-refresh-btn'));

    // Ensure jsQR is loaded
    if (typeof jsQR === 'undefined') {
      console.log('[SCANNER] jsQR not loaded, attempting dynamic load...');
      try {
        await loadJsQR();
      } catch (err) {
        showToast('Gagal memuat library scanner. Periksa koneksi internet.', 'error');
        console.error('[SCANNER] Failed to load jsQR:', err);
        return;
      }
    }

    updateNetworkStatus();
    window.addEventListener('online', () => {
      updateNetworkStatus();
      showToast('Koneksi Internet tersedia', 'success');
      checkForUpdates(); // Check for updates when coming online
    });
    window.addEventListener('offline', () => {
      updateNetworkStatus();
      showToast('Offline mode', 'warning');
    });

    // iOS specific handling
    initIOSHandling();

    // Listen for service worker messages
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'CACHE_BUST') {
          console.log('[PWA] Cache bust received:', event.data);
          if (event.data.force) {
            // Force refresh immediately
            window.location.reload(true);
          } else {
            // Just notify user about update
            showToast(`Update ${event.data.version} tersedia! Refresh halaman.`, 'info', 10000);
          }
        }
      });
    }

    const deviceLoaded = await loadDeviceInfo();

    if (!deviceLoaded) {
      document.getElementById('setup-modal').classList.remove('hidden');
      await fetchTenantList();
    } else {
      initScanner();
    }

    document.getElementById('setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const deviceData = {
        device_id: formData.get('device_id'),
        tenant_id: formData.get('tenant_id'),
        school_name: formData.get('school_name'),
        device_name: formData.get('device_name')
      };
      await registerDevice(deviceData);
    });

    document.getElementById('skip-setup').addEventListener('click', () => {
      document.getElementById('setup-modal').classList.add('hidden');
      showToast('Mode Demo - Fitur terbatas', 'warning');
      initScanner();
    });

    document.getElementById('sync-btn')?.addEventListener('click', async () => {
      await sendClickLog('sync'); // Log to server
      attemptSync();
    });

    document.getElementById('manual-scan-btn')?.addEventListener('click', async () => {
      await sendClickLog('manual-scan'); // Log to server
      initScanner();
    });

    document.getElementById('torch-btn')?.addEventListener('click', async () => {
       await sendClickLog('torch'); // Log to server
       if (state.stream) {
         try {
           const videoTrack = state.stream.getVideoTracks()[0];
           const capabilities = videoTrack.getCapabilities();
           if ('torch' in capabilities) {
             const currentTorch = videoTrack.getSettings().torch || false;
             await videoTrack.applyConstraints({ advanced: [{ torch: !currentTorch }] });
               const btn = document.getElementById('torch-btn');
               if (btn) {
                 btn.classList.toggle('bg-yellow-600', !currentTorch);
                 btn.classList.toggle('bg-gray-600', currentTorch);
                 btn.title = !currentTorch ? 'Matikan torch' : 'Nyalakan torch';
               }
              showToast(!currentTorch ? 'Torch ON' : 'Torch OFF', 'info', 1500);
           } else {
             showToast('Torch tidak didukung oleh kamera ini', 'warning');
           }
         } catch (e) {
           console.error('[TORCH] Error toggling torch:', e);
           showToast('Gagal mengubah torch: ' + e.message, 'error');
         }
       } else {
         showToast('Kamera belum aktif', 'warning');
       }
     });

    // Switch camera button
    document.getElementById('switch-camera-btn')?.addEventListener('click', async () => {
      await sendClickLog('switch-camera'); // Log to server
      if (state.stream) {
        state.currentFacingMode = state.currentFacingMode === 'environment' ? 'user' : 'environment';
        await stopScanner();
        showToast(`Beralih ke kamera ${state.currentFacingMode === 'environment' ? 'belakang' : 'depan'}`, 'info');
        await initScanner();
      }
    });

    // Force refresh button
    const forceRefreshBtn = document.getElementById('force-refresh-btn');
    if (forceRefreshBtn) {
      console.log('[INIT] Force refresh button found, adding listener');
      forceRefreshBtn.addEventListener('click', async () => {
        console.log('[BUTTON] Force refresh clicked');
        await sendClickLog('force-refresh'); // Log to server
        if (typeof forceAppRefresh === 'function') {
          forceAppRefresh();
        } else {
          console.error('[BUTTON] forceAppRefresh function not found');
          showToast('Error: Function tidak tersedia', 'error');
        }
      });
    } else {
      console.warn('[INIT] Force refresh button not found in DOM');
    }

    document.getElementById('close-modal').addEventListener('click', () => {
      document.getElementById('scan-result-modal').classList.add('hidden');
    });

    updatePendingCount();
    registerBackgroundSync();

    // Check for updates on startup
    checkForUpdates();

    console.log('[SCANNER] Initialized - all event listeners registered');
    console.log('[INIT] Available buttons:', {
      torch: !!document.getElementById('torch-btn'),
      switch: !!document.getElementById('switch-camera-btn'),
      sync: !!document.getElementById('sync-btn'),
      manual: !!document.getElementById('manual-scan-btn'),
      force: !!document.getElementById('force-refresh-btn')
    });
  }

  async function fetchTenantList() {
    try {
      const response = await fetch('/api/public/tenants');
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          state.schoolList = result.data;
          const select = document.getElementById('tenant-select');
          select.innerHTML = '<option value="">Pilih Sekolah...</option>';
          result.data.forEach(school => {
            const option = document.createElement('option');
            option.value = school.tenant_id;
            option.textContent = school.nama_sekolah;
            select.appendChild(option);
          });

          select.addEventListener('change', (e) => {
            const selected = state.schoolList.find(s => s.tenant_id === e.target.value);
            if (selected) {
              document.getElementById('school-name-input').value = selected.nama_sekolah;
            }
          });
        }
      }
    } catch (error) {
      console.error('[SETUP] Failed to fetch tenants:', error);
    }
  }

   if (document.readyState === 'loading') {
     document.addEventListener('DOMContentLoaded', init);
   } else {
     init();
   }
 })();
