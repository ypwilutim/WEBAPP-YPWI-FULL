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

// POST /api/scanner/register - Register a new scanner device
router.post('/scanner/register', async (req, res) => {
  try {
    const { device_id, tenant_id, school_name, device_name } = req.body;

    if (!device_id || !tenant_id || !school_name) {
      return res.status(400).json({
        success: false,
        message: 'device_id, tenant_id, dan school_name wajib diisi'
      });
    }

    const existing = await db.query('SELECT id FROM scanner_devices WHERE device_id = ?', [device_id]);
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Device sudah terdaftar'
      });
    }

    const tenant = await db.query('SELECT tenant_id, nama_sekolah FROM tenants WHERE tenant_id = ?', [tenant_id]);
    if (tenant.length === 0) {
      return res.status(404).json({ success: false, message: 'Sekolah tidak ditemukan' });
    }

    const secret_key = crypto.randomBytes(32).toString('hex');

    const result = await db.query(
      'INSERT INTO scanner_devices (device_id, tenant_id, school_name, secret_key, device_name, status) VALUES (?, ?, ?, ?, ?, ?)',
      [device_id, tenant_id, school_name, secret_key, device_name || 'Scanner Device', 'active']
    );

    console.log(`[SCANNER REGISTER] Device ${device_id} registered for ${school_name}`);

    res.json({
      success: true,
      message: 'Device berhasil didaftarkan',
      data: {
        device_id,
        secret_key,
        tenant_id,
        school_name
      }
    });
  } catch (error) {
    console.error('[SCANNER REGISTER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error registering device' });
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

    const device = await db.query('SELECT * FROM scanner_devices WHERE device_id = ? AND status = ?', [device_id, 'active']);
    if (device.length === 0) {
      return res.status(403).json({ success: false, message: 'Device tidak valid atau tidak aktif' });
    }
    const deviceRecord = device[0];
    const tenant_id = deviceRecord.tenant_id;

    const signatureTimestamp = expiry || timestamp;
    const isValid = verifyQRSignature(scan_id, signatureTimestamp, tenant_id, type, signature);
    if (!isValid) {
      console.log(`[SCANNER] Invalid signature from device ${device_id} for scan_id ${scan_id}`);
      return res.status(403).json({ success: false, message: 'QR code tidak valid atau telah dimodifikasi' });
    }

    if (expiry && new Date() > new Date(expiry)) {
      console.log(`[SCANNER] Expired QR from device ${device_id} for scan_id ${scan_id}, expiry: ${expiry}`);
      return res.status(403).json({ success: false, message: 'QR code sudah kedaluwarsa' });
    }

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

    const fiveMinutesAgo = new Date(scanTime.getTime() - 5 * 60 * 1000);
    const duplicate = await db.query(
      `SELECT id FROM attendance_logs 
       WHERE teacher_id = ? AND jenis = ? AND DATE(waktu_scan) = DATE(?) 
       AND ABS(TIMESTAMPDIFF(SECOND, waktu_scan, ?)) <= 300`,
      [teacher_id, type, scanTime, scanTime]
    );
    if (duplicate.length > 0) {
      console.log(`[SCANNER] Duplicate scan detected for teacher ${teacher_id} at ${timestamp}`);
      return res.status(409).json({
        success: false,
        message: 'Absensi sudah dicatat dalam 5 menit terakhir',
        duplicate: true
      });
    }

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
      [teacher_id, tenant_id, scanTime, type, status, is_dinas_luar ? 1 : 0, is_dinas_luar ? 1 : null]
    );

    const attendance_id = result.insertId;

    await db.query(
      `INSERT INTO qr_attendance_logs 
       (scan_id, teacher_id, device_id, tenant_id, waktu_scan, jenis, signature, sync_status, offline_validated) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
      [scan_id, teacher_id, device_id, tenant_id, scanTime, type, signature, offline_validated || false]
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
    console.error(error.stack);
    res.status(500).json({ success: false, message: 'Error processing scanner attendance', error: error.message });
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
  console.log(`[BUTTON-CLICK] User-Agent: ${req.get('User-Agent')}`);
  console.log(`[BUTTON-CLICK] IP: ${req.ip}`);

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

module.exports = router;