// ============================================================
// SCANNER ROUTES - QR Code & Device Management
// Extracted from server.js for modular architecture
// ============================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const SCANNER_SECRET_KEY = process.env.SCANNER_SECRET_KEY || 'ypwi-scanner-secret-2026';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const generateQRSignature = (scanId, timestamp, tenantId, type) => {
  const payload = `${scanId}|${timestamp}|${tenantId}|${type}`;
  return crypto.createHmac('sha256', SCANNER_SECRET_KEY).update(payload).digest('hex');
};

const verifyQRSignature = (scanId, timestamp, tenantId, type, signature) => {
  try {
    const expected = generateQRSignature(scanId, timestamp, tenantId, type);
    const legacySignature = 'legacy-' + scanId;
    if (signature === legacySignature) {
      return true;
    }
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (error) {
    console.log('[SCANNER] Signature verification error:', error.message);
    return false;
  }
};

// ============================================================
// PUBLIC ROUTES (No Auth Required)
// ============================================================

// GET /api/public/tenants - Public endpoint for scanner device setup
router.get('/public/tenants', async (req, res) => {
  try {
    const tenants = await db.query('SELECT tenant_id, nama_sekolah FROM tenants ORDER BY nama_sekolah ASC');
    res.json({ success: true, data: tenants });
  } catch (error) {
    console.error('[PUBLIC TENANTS] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenants' });
  }
});

// GET /api/scanner/device-status - [BARU] Heartbeat status untuk mendeteksi lockout/maintenance
router.get('/scanner/device-status', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) {
    return res.status(400).json({ success: false, message: 'device_id diperlukan' });
  }

  try {
    const device = await db.query('SELECT status, school_name FROM scanner_devices WHERE device_id = ?', [device_id]);
    if (device.length === 0) {
      return res.json({ success: true, status: 'unregistered' });
    }

    res.json({
      success: true,
      status: device[0].status, // 'active', 'inactive', 'maintenance'
      school_name: device[0].school_name
    });
  } catch (error) {
    console.error('[DEVICE STATUS] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error checking device status' });
  }
});

// GET /api/scanner/tenants/registration-token
// 1. RUTE GET TOKEN
router.get('/scanner/tenants/registration-token', authenticateToken, async (req, res) => {
  try {
    const { tenant_id } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'Tenant ID diperlukan' });
    }

    const rows = await db.query(
      'SELECT registration_token FROM tenants WHERE tenant_id = ?',
      [tenant_id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Sekolah tidak ditemukan' });
    }

    res.json({
      success: true,
      token: rows[0].registration_token || 'TOKEN_BELUM_DIBUAT'
    });
  } catch (error) {
    console.error('Error fetching registration token:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});
// POST /api/scanner/tenants/generate-token
// Rute untuk membuat atau memperbarui token registrasi sekolah
router.post('/scanner/tenants/generate-token', authenticateToken, async (req, res) => {
  try {
    const { tenant_id } = req.body; // Mengambil tenant_id dari body request

    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'Tenant ID diperlukan' });
    }

    // 1. Buat token acak yang unik (contoh: reg-ypwi-xxxxxx)
    const randomString = crypto.randomBytes(8).toString('hex');
    const newToken = `reg-${tenant_id.toLowerCase()}-${randomString}`;

    // 2. Simpan token baru tersebut ke database MySQL
    await db.query(
      'UPDATE tenants SET registration_token = ? WHERE tenant_id = ?',
      [newToken, tenant_id]
    );

    // 3. Kembalikan token baru ke frontend
    res.json({
      success: true,
      message: 'Token pendaftaran berhasil dibuat',
      token: newToken
    });

  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ success: false, message: 'Gagal membuat token baru' });
  }
});

// POST /api/scanner/register - [DIPERBARUI DENGAN CLIENT-SIDE DEVICE LOCKING]
router.post('/scanner/register', async (req, res) => {
  try {
    // Ambil data murni termasuk secret_key yang dibuat otomatis oleh tablet
    const { device_id, tenant_id, school_name, device_name, reg_token, secret_key } = req.body;

    // Validasi parameter wajib sebelum menyentuh query database
    if (!tenant_id || !reg_token || !device_id || !secret_key) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID, Token Registrasi, Device ID, dan Secret Key wajib diisi!'
      });
    }

    // ====================================================================
    // LANGKAH 1: PENCOCOKAN SLOT TOKEN DI DATABASE
    // ====================================================================
    const checkSql = `
      SELECT id, tenant_id, registration_token, device_id, secret_key, status, school_name 
      FROM scanner_devices 
      WHERE TRIM(tenant_id) LIKE ? AND TRIM(registration_token) LIKE ? 
      LIMIT 1
    `;

    const cleanTenant = tenant_id.trim();
    const cleanToken = reg_token.trim();

    const queryResult = await db.query(checkSql, [cleanTenant, cleanToken]);
    let deviceSlot = null;

    // Normalisasi Driver Database (mysql2 / Array destruct check)
    if (Array.isArray(queryResult)) {
      if (Array.isArray(queryResult[0]) && queryResult[0].length > 0) {
        deviceSlot = queryResult[0][0];
      }
      else if (queryResult[0] && typeof queryResult[0] === 'object' && !Array.isArray(queryResult[0])) {
        deviceSlot = queryResult[0];
      }
    }

    // JIKA SLOT TOKEN TIDAK DITEMUKAN
    if (!deviceSlot) {
      return res.status(401).json({
        success: false,
        message: 'Kombinasi Sekolah (Tenant ID) atau Token Registrasi salah / tidak terdaftar di Pusat YPWI.'
      });
    }

    // ====================================================================
    // LANGKAH 2: VALIDASI PENGUNCIAN PERANGKAT (DEVICE LOCKING)
    // ====================================================================
    if (deviceSlot.status === 'active') {
      // TOLERANSI RE-LOGIN: Jika device_id DAN secret_key cocok dengan yang ada di DB,
      // artinya ini perangkat yang sama yang tidak sengaja ter-refresh atau install ulang. Izinkan lolos!
      if (deviceSlot.device_id === device_id.trim() && deviceSlot.secret_key === secret_key.trim()) {
        console.log(`[RE-LOGIN] Device ${device_id} masuk kembali menggunakan kunci yang sama.`);
      } else {
        // BLOKIR: Jika device_id atau secret_key berbeda, berarti ada perangkat lain yang coba mencuri token ini.
        return res.status(409).json({
          success: false,
          message: 'Registrasi Ditolak! Token otorisasi ini sudah dikunci eksklusif oleh perangkat lain.'
        });
      }
    }

    // ====================================================================
    // LANGKAH 3: MENULIS KUNCI DAN DATA TABLET KE DATABASE SISANYA
    // ====================================================================
    const finalDeviceName = device_name ? device_name.trim() : 'Laptop/Tablet Lapangan';
    const cleanDeviceId = device_id.trim();
    const cleanSecretKey = secret_key.trim();

    const updateSql = `
      UPDATE scanner_devices 
      SET device_id = ?, device_name = ?, secret_key = ?, status = 'active', last_sync = NOW() 
      WHERE id = ?
    `;

    // Amankan slot dengan memasukkan device_id dan secret_key milik perangkat pertama
    await db.query(updateSql, [cleanDeviceId, finalDeviceName, cleanSecretKey, deviceSlot.id]);

    console.log(`[LOCKING SUCCESS] Token ${reg_token} resmi dikunci oleh Device: ${cleanDeviceId}`);

    // ====================================================================
    // LANGKAH 4: KIRIM BALIK RESPONS SUKSES KE FRONTEND
    // ====================================================================
    res.json({
      success: true,
      message: 'Perangkat berhasil didaftarkan dan token telah dikunci!',
      data: {
        id: deviceSlot.id,
        device_id: cleanDeviceId,
        tenant_id: deviceSlot.tenant_id,
        school_name: deviceSlot.school_name,
        device_name: finalDeviceName,
        secret_key: cleanSecretKey // Kembalikan secret_key murni bawaan tablet untuk disimpan ke localStorage
      }
    });

  } catch (error) {
    console.error('Error pada proses aktivasi token-tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan internal database: ' + error.message
    });
  }
});



// POST /api/scanner/attendance - Receive attendance scan from scanner device
router.post('/scanner/attendance', async (req, res) => {
  try {
    const { scan_id, timestamp, type, device_id, signature, offline_validated, expiry } = req.body;

    if (!scan_id || !timestamp || !type || !device_id || !signature) {
      return res.status(400).json({
        success: false,
        message: 'scan_id, timestamp, type, device_id, dan signature wajib diisi'
      });
    }

    if (!['masuk', 'pulang'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Tipe harus masuk atau pulang' });
    }

    // [DIPERBARUI] Hanya device yang berstatus 'active' yang diizinkan memproses absensi ke database online
    const device = await db.query('SELECT * FROM scanner_devices WHERE device_id = ?', [device_id]);
    if (device.length === 0) {
      return res.status(403).json({ success: false, message: 'Device tidak valid atau tidak terdaftar' });
    }

    const deviceRecord = device[0];
    if (deviceRecord.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Akses ditolak. Status perangkat saat ini: ${deviceRecord.status.toUpperCase()}`
      });
    }

    const tenant_id = deviceRecord.tenant_id;

    // ====================================================================
    // 🌟 [MODIFIKASI] JALUR TOLERANSI KARTU LAMA (LEGACY / ANGKA MURNI)
    // ====================================================================
    let isValid = false;

    if (signature && signature.startsWith('legacy-')) {
      // Jika dikirim oleh perangkat aktif yang terdaftar di atas, kartu angka murni langsung dipercaya!
      isValid = true;
      console.log(`[LEGACY SCAN] Meloloskan kartu angka murni via Token Device: ${device_id} untuk ID: ${scan_id}`);
    } else {
      // Jalur validasi ketat QR Code V5.0 bawaan Anda
      const signatureTimestamp = expiry || timestamp;
      isValid = verifyQRSignature(scan_id, signatureTimestamp, tenant_id, type, signature);
    }

    if (!isValid) {
      console.log(`[SCANNER] Invalid signature from device ${device_id} for scan_id ${scan_id}`);
      return res.status(403).json({ success: false, message: 'QR code tidak valid atau telah dimodifikasi' });
    }

    // Pengecekan kedaluwarsa hanya berlaku untuk QR Code dinamis V5.0 (Kartu lama dilewati)
    if (!signature.startsWith('legacy-') && expiry && new Date() > new Date(expiry)) {
      console.log(`[SCANNER] Expired QR from device ${device_id} for scan_id ${scan_id}, expiry: ${expiry}`);
      return res.status(403).json({ success: false, message: 'QR code sudah kedaluwarsa' });
    }
    // ====================================================================

    const teacher = await db.query('SELECT id, nama, jenis_kelamin FROM teachers WHERE scan_id = ? AND status_aktif = 1', [scan_id]);
    if (teacher.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan dengan scan_id tersebut' });
    }
    const teacherRecord = teacher[0];
    const teacher_id = teacherRecord.id;

    const assignments = await db.query('SELECT tenant_id FROM teacher_assignments WHERE teacher_id = ?', [teacher_id]);
    const assignedTenantIds = assignments.map(a => a.tenant_id);
    const is_dinas_luar = !assignedTenantIds.includes(tenant_id);

    const scanTime = new Date(timestamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({ success: false, message: 'Format timestamp tidak valid' });
    }
    const localDateString = scanTime.toLocaleDateString('en-CA');

    // ====================================================================
    // 🔥 [SOLUSI FINAL TIMEZONE]: Serahkan Pembandingan Tanggal ke MySQL
    // ====================================================================
    // Kita kirim string timestamp apa adanya ke MySQL, lalu minta MySQL
    // mengonversi parameter input dan kolom database ke tanggal yang sama.

    // ====================================================================
    // 🛡️ [PERBAIKAN FINAL STABIL]: Gunakan String Mentah untuk Duplikasi
    // ====================================================================
    // Karena tablet mengirimkan teks waktu lokal ("2026-05-21 07:46:00"), 
    // kita ambil 10 karakter pertamanya saja ("2026-05-21") untuk mencocokkan tanggal.
    // ====================================================================
    // 🛡️ [PERBAIKAN] Gunakan String Mentah agar Sinkron dengan Database
    // ====================================================================
    const rawDateString = timestamp.substring(0, 10); // "2026-05-21"

    const duplicate = await db.query(
      "SELECT id FROM attendance_logs WHERE teacher_id = ? AND jenis = ? AND DATE(waktu_scan) = ?",
      [teacher_id, type, rawDateString]
    );

    if (duplicate.length > 0) {
      console.log(`[SCANNER DIKUNCI] Double-scan harian ditolak untuk guru ${teacherRecord.nama} pada tanggal lokal ${rawDateString}`);
      return res.status(409).json({
        success: false,
        message: `Absensi ${type.toUpperCase()} Anda untuk tanggal ${rawDateString} sudah tercatat di sistem pusat.`,
        duplicate: true
      });
    }
    // (Hapus blok pengecekan duplicate kedua yang double di bawahnya agar kode bersih)
    // ====================================================================

    let status = 'terlambat';

    try {
      const [tenantData] = await db.query('SELECT use_central_rules FROM tenants WHERE tenant_id = ?', [tenant_id]);
      let rulesTenantId = tenant_id;
      if (tenantData && tenantData.use_central_rules) {
        rulesTenantId = 'YPWILUTIM';
      }

      const currentDay = scanTime.toLocaleDateString('id-ID', { weekday: 'long' }).toLowerCase();

      const allRules = await db.query(
        'SELECT status_log, hari, jam_mulai FROM attendance_rules WHERE tenant_id = ? AND tipe = ? AND ? BETWEEN jam_mulai AND jam_selesai ORDER BY jam_mulai DESC',
        [rulesTenantId, type === 'masuk' ? 'Datang' : 'Pulang', scanTime.toTimeString().slice(0, 8)]
      );

      const matchingRules = allRules.filter(rule => {
        if (!rule.hari || rule.hari.trim() === '') return true;
        const ruleDays = rule.hari.toLowerCase().split(',').map(d => d.trim());
        return ruleDays.includes(currentDay);
      });

      if (matchingRules.length > 0) {
        status = matchingRules[0].status_log;
      }
    } catch (ruleError) {
      console.log('[SCANNER] Could not fetch attendance rules, using default terlambat');
    }

    const result = await db.query(
      `INSERT INTO attendance_logs
        (teacher_id, tenant_id, waktu_scan, jenis, metode, status, dinas_luar, kegiatan_dinas, selfie_url, latitude, longitude)
        VALUES (?, ?, ?, ?, 'scanner', ?, ?, ?, NULL, NULL, NULL)`,
      [teacher_id, tenant_id, timestamp, type, status, is_dinas_luar ? 1 : 0, is_dinas_luar ? 1 : null] // 👈 Ganti scanTime menjadi timestamp
    );

    const attendance_id = result.insertId;

    await db.query(
      `INSERT INTO qr_attendance_logs 
        (scan_id, teacher_id, device_id, tenant_id, waktu_scan, jenis, signature, sync_status, offline_validated) 
        VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
      [scan_id, teacher_id, device_id, tenant_id, timestamp, type, signature, offline_validated || false] // 👈 Ganti scanTime menjadi timestamp
    );

    await db.query('UPDATE scanner_devices SET last_sync = NOW() WHERE device_id = ?', [device_id]);

    console.log(`[SCANNER] Attendance recorded: ${teacherRecord.nama} (${scan_id}) - ${type} at ${timestamp}`);

    res.json({
      success: true,
      message: 'Absensi berhasil dicatat',
      data: {
        id: attendance_id,
        teacher_id,
        teacher_name: teacherRecord.nama,
        timestamp: scanTime.toISOString(),
        type,
        status,
        offline_validated: offline_validated || false
      }
    });
  } catch (error) {
    console.error('[SCANNER ATTENDANCE ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error processing scanner attendance', error: error.message });
  }
});

// Konsep Logika Backend (Contoh: Node.js / Express)
router.get('/scanner/attendance-rules', async (req, res) => {
  const { tenant_id } = req.query; // Dikirim oleh tablet saat request

  // 1. Cek pengaturan tenant
  const [tenant] = await db.query("SELECT use_central_rules FROM tenants WHERE tenant_id = ?", [tenant_id]);

  let targetTenant = tenant_id;
  if (tenant && tenant.use_central_rules === 1) {
    targetTenant = 'YPWILUTIM'; // Alihkan ke aturan pusat jika bernilai 1
  }

  // 2. Ambil aturan absensi yang berlaku
  const rules = await db.query("SELECT * FROM attendance_rules WHERE tenant_id = ?", [targetTenant]);

  res.json({
    success: true,
    use_central: tenant ? tenant.use_central_rules === 1 : false,
    rules: rules || [] // Mengirimkan array penuh
  });
});

/**
   * GET /api/scanner/attendance/logs
   * Admin: View all scanner attendance logs (with filters)
   */
router.get('/scanner/attendance/logs', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { date, device_id, sync_status, limit = 100 } = req.query;

    let query = `
        SELECT 
          qal.*,
          t.nama as teacher_name,
          t.scan_id,
          sd.school_name,
          sd.device_name
        FROM qr_attendance_logs qal
        LEFT JOIN teachers t ON qal.teacher_id = t.id
        LEFT JOIN scanner_devices sd ON qal.device_id = sd.device_id
        WHERE 1=1
      `;
    const params = [];

    if (date) {
      query += ' AND DATE(qal.created_at) = ?';
      params.push(date);
    }

    if (device_id) {
      query += ' AND qal.device_id = ?';
      params.push(device_id);
    }

    if (sync_status) {
      query += ' AND qal.sync_status = ?';
      params.push(sync_status);
    }

    query += ' ORDER BY qal.created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const logs = await db.query(query, params);

    res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    console.error('[SCANNER LOGS ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching logs' });
  }
});

// GET /api/scanner/check-status - Check if teacher already scanned today
router.get('/scanner/check-status', async (req, res) => {
  const { scan_id } = req.query;
  if (!scan_id) {
    return res.status(400).json({ success: false, message: 'scan_id required' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const masukCheck = await db.query(
      'SELECT id FROM attendance_logs WHERE teacher_id = (SELECT id FROM teachers WHERE scan_id = ?) AND jenis = \'masuk\' AND DATE(waktu_scan) = ?',
      [scan_id, today]
    );

    const pulangCheck = await db.query(
      'SELECT id FROM attendance_logs WHERE teacher_id = (SELECT id FROM teachers WHERE scan_id = ?) AND jenis = \'pulang\' AND DATE(waktu_scan) = ?',
      [scan_id, today]
    );

    const ruleCheck = await db.query(
      'SELECT jam_mulai as jam_pulang_buka FROM attendance_rules WHERE tipe = \'Pulang\' AND jam_mulai IS NOT NULL ORDER BY jam_mulai ASC LIMIT 1'
    );

    res.json({
      success: true,
      has_masuk: masukCheck.length > 0,
      has_pulang: pulangCheck.length > 0,
      jam_pulang_buka: ruleCheck[0]?.jam_pulang_buka || null
    });
  } catch (error) {
    console.error('[CHECK-STATUS] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error checking status' });
  }
});

// GET /api/version - Public endpoint to get current app version
router.get('/version', (req, res) => {
  res.json({
    success: true,
    version: '1.0.3',
    timestamp: new Date().toISOString(),
    features: [
      'Scanner offline-capable',
      'Auto masuk/pulang detection',
      'Force refresh for PWA',
      'iOS compatibility'
    ]
  });
});

// GET /api/test-buttons - Test endpoint to verify button functionality
router.get('/test-buttons', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running and buttons should work',
    timestamp: new Date().toISOString(),
    buttons: {
      torch: 'Toggle flashlight',
      switch_camera: 'Switch front/back camera',
      sync: 'Sync offline data',
      manual_scan: 'Start manual scan',
      force_refresh: 'Force app refresh',
      test: 'Test button'
    }
  });
});

// POST /api/log-click - Log button clicks from scanner (for mobile debugging)
router.post('/log-click', (req, res) => {
  const { button, userAgent, timestamp } = req.body;
  console.log(`[BUTTON-CLICK] ${button} clicked at ${timestamp}`);

  res.json({
    success: true,
    message: `Button ${button} click logged`,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// ADMIN ROUTES (Require Auth)
// ============================================================

// GET /api/scanner/status - Admin endpoint to check scanner device status
router.get('/scanner/status', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const devices = await db.query(`
      SELECT 
        sd.*,
        COUNT(qal.id) as total_scans_today,
        MAX(qal.created_at) as last_scan_time
      FROM scanner_devices sd
      LEFT JOIN qr_attendance_logs qal 
        ON sd.device_id = qal.device_id 
        AND DATE(qal.created_at) = CURDATE()
      GROUP BY sd.id
      ORDER BY sd.school_name ASC
    `);

    res.json({
      success: true,
      data: devices
    });
  } catch (error) {
    console.error('[SCANNER STATUS ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching scanner status' });
  }
});

/**
   * GET /api/scanner/devices
   * Admin: List all scanner devices with status
   */
router.get('/scanner/devices', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const devices = await db.query(`
        SELECT 
          sd.*,
          COUNT(qal.id) as total_scans,
          MAX(qal.created_at) as last_scan
        FROM scanner_devices sd
        LEFT JOIN qr_attendance_logs qal ON sd.device_id = qal.device_id
        GROUP BY sd.id
        ORDER BY sd.school_name ASC
      `);

    res.json({
      success: true,
      data: devices
    });
  } catch (error) {
    console.error('[SCANNER DEVICES LIST ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching devices' });
  }
});

// ============================================================
// 🌟 RUTE BARU: POST /api/scanner/devices
// Menyimpan pendaftaran perangkat scanner baru ke database
// ============================================================
router.post('/scanner/devices', authenticateToken, async (req, res) => {
  try {
    // Logging internal untuk memastikan data masuk dengan sempurna
    console.log("=== DIAGNOSIS BACKEND INCOMING V5.0 ===");
    console.log("Isi req.body asli:", JSON.stringify(req.body, null, 2));

    const { tenant_id, device_id, school_name, device_name, status } = req.body;

    // Paksa ambil string murninya dengan toleransi snake_case dan camelCase
    const finalToken = String(req.body.registration_token || req.body.deviceRegistrationToken || '').trim();

    console.log("Nilai finalToken yang SIAP DIKIRIM ke MySQL:", finalToken);
    console.log("=======================================");

    // Validasi data wajib dari admin pusat
    if (!tenant_id || !school_name || !finalToken) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id, school_name, dan registration_token wajib terpenuhi.'
      });
    }

    // Ambil fallback aman jika device_id atau device_name kosong dari client-side
    const securedDeviceId = device_id || `${tenant_id.toUpperCase()}-GEN-${Math.floor(1000 + Math.random() * 9000)}`;
    const securedDeviceName = device_name || `Scanner ${school_name}`;
    const securedStatus = status || 'active';

    // Query SQL yang aman. Kita gunakan tanda tanya (?) untuk token agar terhindar dari SQL Injection bugs.
    const sql = `
      INSERT INTO scanner_devices 
      (device_id, tenant_id, school_name, device_name, registration_token, status, created_at) 
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;

    // Eksekusi data ke MySQL. Array parameter HARUS sejajar dengan urutan tanda tanya (?) di atas.
    await db.query(sql, [
      String(securedDeviceId),
      String(tenant_id),
      String(school_name),
      String(securedDeviceName),
      String(finalToken),
      String(securedStatus)
    ]);

    res.json({
      success: true,
      message: 'Otorisasi Tenant & Token Baru Berhasil Direkam di Database Pusat.',
      data: {
        tenant_id: tenant_id,
        token: finalToken
      }
    });

  } catch (error) {
    console.error('Error saat menyimpan device baru:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan internal server pusat: ' + error.message
    });
  }
});

router.put('/scanner/devices/:device_id', authenticateToken, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { school_name, tenant_id, registration_token, status } = req.body;

    const sql = `UPDATE scanner_devices SET 
                 school_name = ?, tenant_id = ?, registration_token = ?, status = ? 
                 WHERE device_id = ?`;

    // UBAH DARI: const [result] = await db.query(...)
    // MENJADI:
    const result = await db.query(sql, [school_name, tenant_id, registration_token, status, device_id]);

    // Jika result adalah array (seperti mysql2), ambil indeks 0
    // Jika result adalah objek (seperti hasil langsung), tetap gunakan result
    const affectedRows = Array.isArray(result) ? result[0].affectedRows : result.affectedRows;

    if (affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
    }

    res.json({ success: true, message: 'Data berhasil diperbarui' });
  } catch (error) {
    console.error("DEBUG ERROR:", error); // Lihat error aslinya di terminal
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;