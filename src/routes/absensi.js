// ============================================================
// ABSENSI ROUTES - Extracted from server.js for modular architecture
// Version: 2.0.0 (Post-Migration with attendance_rules support)
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../../db');
const { authenticateToken, authenticateOperator, isDayMatch, calculateDistance } = require('../middleware/auth');
const { route } = require('./absensi');

const router = express.Router();

// ============================================================
// HELPER FUNCTIONS - Imported from middleware/auth.js
// ============================================================

// Multer config for selfie uploads
const selfieStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'selfie/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'selfie-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const selfieUpload = multer({ storage: selfieStorage });

// ============================================================
// ROUTES
// ============================================================

// POST /api/attendance - Record attendance with rule_id support
router.post('/attendance', authenticateToken, selfieUpload.single('selfie'), async (req, res) => {
  try {
    const { jenis, metode, latitude, longitude, dinas_luar, kegiatan_dinas } = req.body || {};
    let selfie_url = null;

    // 1. Amankan parsing data string dari FormData / Multipart-form
    let is_dinas_luar = dinas_luar === 'true' || dinas_luar === true || dinas_luar === '1';
    let tenant_id = req.user.tenant_id;
    let rule_id = null;

    if (req.file) {
      selfie_url = req.file.path;
    }

    // Fungsi Helper Normalisasi & Jarak (Geofencing)
    const normalize = (str) => (str || "").toString().replace(/\s+/g, '').toUpperCase();

    const calculateDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    // ===================================================================
    // ===================================================================
    // VALIDASI 1: AMBIL ATURAN JAM KERJA KETAT (SINKRONISASI KOLOM DB)
    // ===================================================================
    const currentDay = new Date().toLocaleDateString('id-ID', { weekday: 'long' }).toLowerCase();
    const now = new Date();
    const jamSekarangStr = now.toTimeString().slice(0, 5); // Format "HH:MM" (Misal "07:57")

    // 1. QUERY MULTI-BARIS: Mencari baris aturan yang rentang jamnya cocok dengan jam sekarang
    const rulesResultRaw = await db.query(
      `SELECT id, tipe, jam_mulai, jam_selesai, status_log, hari 
       FROM attendance_rules 
       WHERE tenant_id = ? 
         AND ? >= TIME_FORMAT(jam_mulai, '%H:%i') 
         AND ? < TIME_FORMAT(jam_selesai, '%H:%i')
       LIMIT 1`,
      [tenant_id, jamSekarangStr, jamSekarangStr]
    );
    const rulesResult = Array.isArray(rulesResultRaw[0]) ? rulesResultRaw[0] : (Array.isArray(rulesResultRaw) ? rulesResultRaw : []);

    // JIKA TIDAK ADA RENTANG JAM YANG COCOK INI (Diluar jadwal aturan)
    if (rulesResult.length === 0) {
      return res.status(400).json({
        success: false,
        message: `Absensi ditolak! Jam saat ini (${jamSekarangStr} ) berada di luar jendela waktu absensi resmi sekolah.`
      });
    }

    const matchedRule = rulesResult[0];
    rule_id = matchedRule.id;

    // 2. VALIDASI JENIS PRESENSI: Mencegah guru salah klik tombol (Misal: Harusnya Datang tapi klik Pulang)
    // Normalisasi pencocokan: 'Datang' dari DB disamakan dengan request 'masuk'
    const jenisInputMurni = jenis === 'masuk' ? 'datang' : jenis; // 'masuk' -> 'datang', 'pulang' -> 'pulang'
    const tipeAturanDB = matchedRule.tipe.toLowerCase();

    if (jenisInputMurni !== tipeAturanDB) {
      return res.status(400).json({
        success: false,
        message: `Aksi keliru! Berdasarkan jadwal, saat ini adalah waktu untuk Absen ${matchedRule.tipe.toUpperCase()}.`
      });
    }

    // 3. CEK HARI KERJA
    const workingDays = matchedRule.hari ? matchedRule.hari.split(',').map(d => d.trim().toLowerCase()) : ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
    if (!workingDays.includes(currentDay)) {
      return res.status(400).json({
        success: false,
        message: `Absensi gagal! Hari ini (${currentDay.toUpperCase()}) bukan hari kerja efektif untuk aturan ini.`
      });
    }

    // 4. PENENTUAN STATUS LOG: Menyalin langsung dari status_log di database Anda
    // Mengubah format string space menjadi underscore (Misal: "Tepat Waktu" -> "tepat_waktu")
    let status = matchedRule.status_log.toLowerCase().replace(/\s+/g, '_');



    // ===================================================================
    // VALIDASI 2: PROTEKSI ANTI-DUPLIKASI (SATU HARI MAKS 1 MASUK & 1 PULANG)
    // ===================================================================
    const checkDuplicateRaw = await db.query(
      'SELECT id, waktu_scan FROM attendance_logs WHERE teacher_id = ? AND jenis = ? AND DATE(waktu_scan) = CURRENT_DATE() LIMIT 1',
      [req.user.guru_id, jenis]
    );
    const checkDuplicate = Array.isArray(checkDuplicateRaw[0]) ? checkDuplicateRaw[0] : (Array.isArray(checkDuplicateRaw) ? checkDuplicateRaw : []);

    if (checkDuplicate.length > 0) {
      const waktuScan = new Date(checkDuplicate[0].waktu_scan).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return res.status(400).json({
        success: false,
        message: `Anda sudah melakukan absensi ${jenis} hari ini pada jam ${waktuScan} WITA.`
      });
    }

    if (jenis === 'pulang') {
      const checkMasukRaw = await db.query(
        'SELECT id FROM attendance_logs WHERE teacher_id = ? AND jenis = "masuk" AND DATE(waktu_scan) = CURRENT_DATE() LIMIT 1',
        [req.user.guru_id]
      );
      const checkMasuk = Array.isArray(checkMasukRaw[0]) ? checkMasukRaw[0] : (Array.isArray(checkMasukRaw) ? checkMasukRaw : []);

      if (checkMasuk.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Absensi gagal! Anda harus memiliki record absensi MASUK hari ini sebelum bisa absen pulang.'
        });
      }
    }

    // ===================================================================
    // VALIDASI 3: GEOFENCING (RADAR LOKASI SEKOLAH YPWI)
    // ===================================================================
    // ===================================================================
    // VALIDASI 3: GEOFENCING (RADAR LOKASI SEKOLAH YPWI) - VERSION FIXED
    // ===================================================================
    if (latitude && longitude) {
      try {
        const userLat = parseFloat(latitude);
        const userLng = parseFloat(longitude);

        if (isNaN(userLat) || isNaN(userLng)) {
          return res.status(400).json({
            success: false,
            message: 'Absensi gagal! Format koordinat GPS dari perangkat Anda tidak valid.'
          });
        }

        if (!is_dinas_luar) {
          // 1. Ambil data lokasi utama tenants
          const tenantsLocationsRaw = await db.query(
            'SELECT tenant_id, nama_sekolah, latitude, longitude, location_radius, tipe_unit FROM tenants WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
          );
          const tenantsLocations = Array.isArray(tenantsLocationsRaw[0]) ? tenantsLocationsRaw[0] : (Array.isArray(tenantsLocationsRaw) ? tenantsLocationsRaw : []);

          // 2. Ambil data sub-lokasi cabang/titik lain
          const tenantLocationsDataRaw = await db.query(
            'SELECT tl.tenant_id, t.nama_sekolah, tl.latitude, tl.longitude, tl.location_radius, t.tipe_unit FROM tenant_locations tl JOIN tenants t ON tl.tenant_id = t.tenant_id WHERE tl.latitude IS NOT NULL AND tl.longitude IS NOT NULL AND tl.is_active = 1'
          );
          const tenantLocationsData = Array.isArray(tenantLocationsDataRaw[0]) ? tenantLocationsDataRaw[0] : (Array.isArray(tenantLocationsDataRaw) ? tenantLocationsDataRaw : []);

          // Gabungkan semua data ke array flat tanpa menggunakan Map agar data dengan tenant_id yang sama tidak saling menimpa
          const allLocations = [...tenantsLocations, ...tenantLocationsData];

          let withinAssigned = false;
          let withinOther = false;

          const userHomeTenantNorm = normalize(req.user.tenant_id);

          // Filter lokasi yang cocok dengan sekolah asal user
          const homeLocations = allLocations.filter(loc => normalize(loc.tenant_id) === userHomeTenantNorm);

          // LOOP 1: Cari kecocokan di area sekolah asal user terlebih dahulu
          for (const location of homeLocations) {
            // Pembersihan string koordinat dari spasi tersembunyi
            const targetLat = parseFloat((location.latitude || "").toString().trim());
            const targetLng = parseFloat((location.longitude || "").toString().trim());

            if (isNaN(targetLat) || isNaN(targetLng)) continue;

            const distance = calculateDistance(userLat, userLng, targetLat, targetLng);
            const radius = parseInt(location.location_radius) || 100;

            // Konversi jarak ke meter (distance * 1000). Ditambah toleransi akurasi GPS 50 meter
            if ((distance * 1000) <= radius + 50) {
              withinAssigned = true;
              break;
            }
          }

          // LOOP 2: Jika gagal di sekolah sendiri, sisir cadangan ke seluruh properti sekolah lain
          if (!withinAssigned) {
            for (const location of allLocations) {
              const targetLat = parseFloat((location.latitude || "").toString().trim());
              const targetLng = parseFloat((location.longitude || "").toString().trim());

              if (isNaN(targetLat) || isNaN(targetLng)) continue;

              const distance = calculateDistance(userLat, userLng, targetLat, targetLng);
              const radius = parseInt(location.location_radius) || 100;

              if ((distance * 1000) <= radius + 50) {
                // FALLBACK: Jika ternyata titik koordinatnya lolos di sini dan itu adalah sekolah asalnya sendiri
                if (normalize(location.tenant_id) === userHomeTenantNorm) {
                  withinAssigned = true;
                } else {
                  withinOther = true;
                  tenant_id = location.tenant_id;
                  is_dinas_luar = true; // Ditandai dinas luar otomatis karena berada di cabang YPWI lain
                }
                break;
              }
            }
          }

          // Verifikasi Akhir Radar Geofencing
          if (!withinAssigned && !withinOther) {
            return res.status(403).json({
              success: false,
              message: 'Absensi gagal! Anda berada di luar radius lokasi seluruh unit sekolah YPWI.'
            });
          }
        } else {
          tenant_id = req.user.tenant_id || tenant_id;
        }
      } catch (locationError) {
        console.error('[LOCATION VALIDATION ERROR]:', locationError);
        return res.status(500).json({ success: false, message: 'Terjadi kegagalan sistem internal pada radar geofencing.' });
      }
    }

    // ===================================================================
    // 4. INJEKSI DATA KE DATABASE (REKAM LOG)
    // ===================================================================
    // Baris 229-239 - Ganti dari NOW() ke parameter waktu
    const insertQuery = `
  INSERT INTO attendance_logs 
  (teacher_id, tenant_id, waktu_scan, jenis, metode, status, dinas_luar, kegiatan_dinas, selfie_url, latitude, longitude, rule_id) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

    await db.query(insertQuery, [
      req.user.guru_id,
      tenant_id,
      req.body.waktu_absen || new Date().toISOString(), // terima timestamp ISO dari frontend
      jenis,
      metode || 'dashboard',
      status,
      is_dinas_luar ? 1 : 0,
      kegiatan_dinas || null,
      selfie_url,
      latitude ? parseFloat(latitude) : null,
      longitude ? parseFloat(longitude) : null,
      rule_id
    ]);

    // ===================================================================
    // 5. AUTOMATED WHATSAPP NOTIFICATION
    // ===================================================================
    try {
      const teacherInfoRaw = await db.query('SELECT nama, no_hp FROM teachers WHERE id = ? LIMIT 1', [req.user.guru_id]);
      const teacherInfo = Array.isArray(teacherInfoRaw[0]) ? teacherInfoRaw[0] : (Array.isArray(teacherInfoRaw) ? teacherInfoRaw : []);

      const tenantInfoRaw = await db.query('SELECT nama_sekolah FROM tenants WHERE tenant_id = ? LIMIT 1', [tenant_id]);
      const tenantInfo = Array.isArray(tenantInfoRaw[0]) ? tenantInfoRaw[0] : (Array.isArray(tenantInfoRaw) ? tenantInfoRaw : []);

      if (teacherInfo.length > 0 && teacherInfo[0].no_hp) {
        const namaGuru = teacherInfo[0].nama;
        const nomorHp = teacherInfo[0].no_hp;
        const namaSekolah = tenantInfo.length > 0 ? tenantInfo[0].nama_sekolah : tenant_id;

        let statusText = status.toUpperCase().replace('_', ' ');
        let statusEmoji = '✅ ' + statusText;
        if (status === 'terlambat') statusEmoji = '⚠️ TERLAMBAT';
        if (status === 'lembur') statusEmoji = '🔥 LEMBUR';
        if (is_dinas_luar) statusEmoji = '💼 DINAS LUAR (Otomatis)';

        const waktuAbsen = req.body.waktu_absen ? new Date(req.body.waktu_absen) : new Date();
        const waktuSekarang = waktuAbsen.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WITA';
        const tanggalSekarang = waktuAbsen.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const waMessage =
          `*NOTIFIKASI PRESENSI YPWI*
Halo *${namaGuru}*,

Laporan absensi Anda telah berhasil direkam oleh sistem database terpadu.

*Detail Presensi:*
• Jenis: Absen ${jenis.toUpperCase()}
• Status: ${statusEmoji}
• Instansi: ${namaSekolah}
• Hari/Tgl: ${tanggalSekarang}
• Jam Log: ${waktuSekarang}
${kegiatan_dinas ? `• Kegiatan: ${kegiatan_dinas}\n` : ''}
Terima kasih atas dedikasi Anda hari ini dalam mendidik siswa-siswi di unit sekolah YPWI.

_Pesan ini dikirim otomatis oleh YPWI Integrated Database System v5.0_`;

        if (typeof sendWhatsApp === 'function') {
          await sendWhatsApp(nomorHp, waMessage);
        }
      }
    } catch (waError) {
      console.error('[WHATSAPP NOTIFICATION ERROR]', waError.message);
    }

    return res.json({ success: true, message: `Absensi ${jenis} berhasil dicatat dengan status [${status}]`, status });

  } catch (error) {
    console.error('[ATTENDANCE ERROR]', error.message);
    return res.status(500).json({ success: false, message: 'Error recording attendance' });
  }
});

// Admin tenants list
router.get('/api/admin/tenants', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    console.log('Fetching tenants...', tenantId ? 'tenant=' + tenantId : 'all');
    var query = 'SELECT tenant_id, nama_sekolah, absensi_method, use_central_rules, latitude, longitude, COALESCE(location_radius, 100) as location_radius, location_name FROM tenants';
    var params = [];
    if (tenantId) {
      query += ' WHERE tenant_id = ? ';
      params.push(tenantId);
    }
    query += ' ORDER BY nama_sekolah ASC';
    var tenants = await db.query(query, params);
    console.log('Tenants fetched:', tenants.length);

    // Format data for frontend
    const result = tenants.map(tenant => ({
      tenant_id: tenant.tenant_id,
      nama_sekolah: tenant.nama_sekolah,
      absensi_method: tenant.absensi_method,
      use_central_rules: tenant.use_central_rules,
      latitude: tenant.latitude,
      longitude: tenant.longitude,
      location_radius: tenant.location_radius,
      location_name: tenant.location_name,
      has_location: !!(tenant.latitude && tenant.longitude)
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Admin tenants error:', error);
    res.status(500).json({ success: false, message: 'Error fetching tenants' });
  }
});

// Admin summary endpoint
router.get('/api/admin/summary', authenticateOperator, async (req, res) => {
  try {
    let tenantId = req.query.tenant_id;

    // Operator: force tenant_id dari assignment jika tidak disediakan
    if (req.user.role !== 'admin' && !tenantId) {
      const adminAssignments = (req.user.assignments || []).filter(a => {
        const roles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
        return roles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''));
      });
      if (adminAssignments.length === 1) {
        tenantId = adminAssignments[0].tenant_id;
      } else if (adminAssignments.length > 1) {
        tenantId = adminAssignments[0].tenant_id;
      }
    }

    // Verify tenant access
    if (tenantId && !verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data sekolah ini' });
    }

    // Get total teachers
    let teacherQuery = 'SELECT COUNT(DISTINCT t.id) as count FROM teachers t';
    let teacherParams = [];
    if (tenantId) {
      teacherQuery += ' JOIN teacher_assignments ta ON t.id = ta.teacher_id AND ta.tenant_id = ? ';
      teacherParams.push(tenantId);
    }
    teacherQuery += ' WHERE t.status_aktif = 1';
    const [totalTeachersResult] = await db.query(teacherQuery, teacherParams);
    const totalTeachers = totalTeachersResult.count;

    // Get active today (teachers who have attendance today)
    let activeQuery = `
      SELECT COUNT(DISTINCT a.teacher_id) as count
      FROM attendance_logs a
      LEFT JOIN teachers t ON a.teacher_id = t.id
      LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
      WHERE DATE(a.waktu_scan) = CURDATE()
    `;
    let activeParams = [];
    if (tenantId) {
      activeQuery += ' AND ta.tenant_id = ? ';
      activeParams.push(tenantId);
    }
    const [activeTodayResult] = await db.query(activeQuery, activeParams);
    const activeToday = activeTodayResult.count;

    // Get late today
    let lateQuery = `
      SELECT COUNT(*) as count
      FROM attendance_logs a
      LEFT JOIN teachers t ON a.teacher_id = t.id
      LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
      WHERE DATE(a.waktu_scan) = CURDATE() AND a.status = 'terlambat'
    `;
    let lateParams = [];
    if (tenantId) {
      lateQuery += ' AND ta.tenant_id = ? ';
      lateParams.push(tenantId);
    }
    const [lateTodayResult] = await db.query(lateQuery, lateParams);
    const lateToday = lateTodayResult.count;

    // Get total locations for this tenant
    let locQuery = 'SELECT COUNT(*) as count FROM tenant_locations WHERE 1=1';
    let locParams = [];
    if (tenantId) {
      locQuery += ' AND tenant_id = ? ';
      locParams = [tenantId];
    }
    const [totalLocationsResult] = await db.query(locQuery, locParams);
    const totalLocations = totalLocationsResult.count;

    res.json({
      success: true,
      data: {
        totalTeachers,
        activeToday,
        lateToday,
        totalLocations
      }
    });
  } catch (error) {
    console.error('Admin summary error:', error);
    res.status(500).json({ success: false, message: 'Error fetching admin summary' });
  }
});

// GANTI KODE RUTE DI src/routes/absensi.js DENGAN INI
router.get('/attendance-rules', authenticateToken, async (req, res) => {
  try {
    // Mengubah db.execute menjadi db.query agar sesuai dengan driver MySQL proyek Anda
    const rules = await db.query(
      'SELECT id, tenant_id, tipe, jam_mulai, jam_selesai, status_log FROM attendance_rules'
    );

    // Beberapa driver mengembalikan data langsung, beberapa mengembalikan array dalam array ([rules])
    // Kita pastikan data yang dikirim adalah array utuh
    const dataRules = Array.isArray(rules) ? rules : (rules.rows || rules[0] || []);

    return res.status(200).json({
      success: true,
      rules: dataRules
    });
  } catch (error) {
    console.error('Error fetching attendance rules:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data aturan absensi internal server.'
    });
  }
});


// Admin attendance logs
router.get('/api/admin/attendance-logs', authenticateOperator, async (req, res) => {
  try {
    const dateFilter = req.query.date;
    const statusFilter = req.query.status;
    let tenantId = req.query.tenant_id;

    // Operator: force tenant_id dari assignment jika tidak disediakan
    if (req.user.role !== 'admin' && !tenantId) {
      const adminAssignments = (req.user.assignments || []).filter(a => {
        const roles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
        return roles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''));
      });
      if (adminAssignments.length === 1) {
        tenantId = adminAssignments[0].tenant_id;
      }
    }

    // Verify tenant access jika tenantId ada
    if (tenantId && !verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data kehadiran sekolah ini' });
    }

    let query = '';
    let params = [];

    if (tenantId) {
      query = `
        SELECT
          al.id, al.teacher_id, al.waktu_scan, al.jenis, al.status, al.metode,
          t.nama, t.nip
        FROM attendance_logs al
        JOIN teachers t ON al.teacher_id = t.id
        LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
        WHERE ta.tenant_id = ?
      `;
      params.push(tenantId);
    } else {
      query = `
        SELECT
          al.id, al.teacher_id, al.waktu_scan, al.jenis, al.status, al.metode,
          t.nama, t.nip
        FROM attendance_logs al
        JOIN teachers t ON al.teacher_id = t.id
        WHERE 1=1
      `;
    }

    if (dateFilter) {
      query += ' AND DATE(al.waktu_scan) = ?';
      params.push(dateFilter);
    }

    if (statusFilter && statusFilter !== '') {
      query += ' AND al.status = ?';
      params.push(statusFilter);
    }

    query += ' ORDER BY al.waktu_scan DESC LIMIT 100';

    const logs = await db.query(query, params);

    res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    console.error('Admin attendance logs error:', error);
    res.status(500).json({ success: false, message: 'Error fetching attendance logs', error: error.message });
  }
});

router.get('/attendance-history', authenticateToken, async (req, res) => {
  try {
    const attendance = await db.query(
      'SELECT jenis, waktu_scan, status FROM attendance_logs WHERE teacher_id = ? ORDER BY waktu_scan DESC LIMIT 10',
      [req.user.guru_id]
    );

    // --- SISIPKAN PROSES FORMATTING DI SINI ---
    const formattedAttendance = attendance.map(item => {
      // Pastikan waktu_scan tidak null/undefined
      if (!item.waktu_scan) return item;

      return {
        ...item,
        // Ini mengubah format database ("2026-05-21 01:13:53")
        // menjadi ISO Standard ("2026-05-20T17:13:53.000Z")
        waktu_scan: new Date(item.waktu_scan.replace(' ', 'T') + 'Z').toISOString()
      };
    });
    // ------------------------------------------

    // Gunakan formattedAttendance, bukan attendance asli
    res.json({ success: true, data: formattedAttendance });

  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching attendance history' });
  }
});

// GET /api/admin/attendance-logs - Admin attendance logs with rule info
router.get('/admin/attendance-logs', authenticateOperator, async (req, res) => {
  try {
    const dateFilter = req.query.date;
    const statusFilter = req.query.status;
    let tenantId = req.query.tenant_id;

    // Operator: force tenant_id from assignment if not provided
    if (req.user.role !== 'admin' && !tenantId) {
      const adminAssignments = (req.user.assignments || []).filter(a => {
        const roles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
        return roles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''));
      });
      if (adminAssignments.length === 1) {
        tenantId = adminAssignments[0].tenant_id;
      }
    }

    // KODE PERBAIKAN AKURAT BERDASARKAN SQL DUMP:
    // 1. Hubungkan tenants (ten) lewat al.tenant_id = ten.tenant_id
    // 2. Ambil ten.nama_sekolah
    // 3. Ambil ar.keterangan AS nama_aturan
    let query = `
      SELECT al.id, al.teacher_id, al.waktu_scan, al.jenis, al.status, al.metode,
             t.nama, t.nip, ten.nama_sekolah, ar.keterangan AS nama_aturan
      FROM attendance_logs al
      JOIN teachers t ON al.teacher_id = t.id
      JOIN tenants ten ON al.tenant_id = ten.tenant_id
      LEFT JOIN attendance_rules ar ON al.rule_id = ar.id
    `;
    let params = [];

    if (tenantId) {
      query += ' WHERE al.tenant_id = ?';
      params.push(tenantId);
    }

    if (dateFilter) {
      query += (tenantId ? ' AND' : ' WHERE') + ' DATE(al.waktu_scan) = ?';
      params.push(dateFilter);
    }

    if (statusFilter && statusFilter !== '') {
      query += (tenantId || dateFilter ? ' AND' : ' WHERE') + ' al.status = ?';
      params.push(statusFilter);
    }

    query += ' ORDER BY al.waktu_scan DESC LIMIT 100';

    const logs = await db.query(query, params);

    res.json({ success: true, data: logs });
  } catch (error) {
    console.error('Admin attendance logs error:', error);
    res.status(500).json({ success: false, message: 'Error fetching attendance logs' });
  }
});

// GET /api/units/nearby - Find nearest units with tipe_unit awareness (includes tenant_locations)
router.get('/units/nearby', authenticateToken, async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required' });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    // Ambil data dari tabel tenants utama
    const tenantsData = await db.query(
      `SELECT tenant_id, nama_sekolah, latitude, longitude, location_radius, tipe_unit
       FROM tenants
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
    );

    // Ambil data dari tabel tenant_locations (cabang/sub-lokasi)
    const subLocationsData = await db.query(
      `SELECT tl.tenant_id, t.nama_sekolah, tl.latitude, tl.longitude,
              tl.location_radius, t.tipe_unit
       FROM tenant_locations tl
       JOIN tenants t ON tl.tenant_id = t.tenant_id
       WHERE tl.latitude IS NOT NULL AND tl.longitude IS NOT NULL AND tl.is_active = 1`
    );

    // Gabungkan kedua array
    const allUnits = [...tenantsData, ...subLocationsData];

    if (allUnits.length === 0) {
      return res.json({
        success: true,
        currentLocation: { lat: userLat, lng: userLng },
        units: [],
        nearestUnit: null
      });
    }

    // Calculate distances for all units
    const unitsWithDistance = allUnits.map(unit => ({
      tenant_id: unit.tenant_id,
      nama_sekolah: unit.nama_sekolah,
      latitude: unit.latitude,
      longitude: unit.longitude,
      location_radius: unit.location_radius,
      tipe_unit: unit.tipe_unit,
      distance: calculateDistance(userLat, userLng, parseFloat(unit.latitude), parseFloat(unit.longitude)),
      isNearest: false
    }));

    // Sort by distance
    unitsWithDistance.sort((a, b) => a.distance - b.distance);

    // Mark actual nearest
    if (unitsWithDistance.length > 0) {
      unitsWithDistance[0].isNearest = true;
    }

    res.json({
      success: true,
      currentLocation: { lat: userLat, lng: userLng },
      units: unitsWithDistance,
      nearestUnit: unitsWithDistance.find(u => u.isNearest) || null
    });
  } catch (error) {
    console.error('Error fetching nearby units:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch nearby units' });
  }
});

// GET /api/units/all - Get all units (tenants + tenant_locations sub-locations) with tipe_unit
router.get('/units/all', authenticateToken, async (req, res) => {
  try {
    // Ambil data dari tabel tenants utama
    const tenantsData = await db.query(
      `SELECT tenant_id, nama_sekolah, latitude, longitude, location_radius, tipe_unit
       FROM tenants
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
    );

    // Ambil data dari tabel tenant_locations (cabang/sub-lokasi)
    const subLocationsData = await db.query(
      `SELECT tl.tenant_id, t.nama_sekolah, tl.latitude, tl.longitude,
              tl.location_radius, t.tipe_unit
       FROM tenant_locations tl
       JOIN tenants t ON tl.tenant_id = t.tenant_id
       WHERE tl.latitude IS NOT NULL AND tl.longitude IS NOT NULL AND tl.is_active = 1`
    );

    // Gabungkan kedua array (jika ada tenant_id yang sama di kedua tabel, tetap tampilkan keduanya)
    const allUnits = [...tenantsData, ...subLocationsData];

    res.json({
      success: true,
      units: allUnits
    });
  } catch (error) {
    console.error('Error fetching all units:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch units' });
  }
});

// POST /api/evaluations/auto-calculate - Auto-calculate evaluations from attendance
router.post('/evaluations/auto-calculate', authenticateToken, async (req, res) => {
  try {
    const evaluator_id = req.user.id;

    // Get all teachers with their assignments and tenant info (with tipe_unit)
    const teachers = await db.query(`
      SELECT DISTINCT t.id, t.nama, ta.tenant_id, tn.tipe_unit, tn.nama_sekolah
      FROM teachers t 
      JOIN teacher_assignments ta ON t.id = ta.teacher_id 
      JOIN tenants tn ON ta.tenant_id = tn.tenant_id
      WHERE t.status_aktif = 1 AND ta.tenant_id IS NOT NULL
    `);

    // Calculate attendance rate per teacher for current month
    const stats = await db.query(`
      SELECT 
        teacher_id,
        tenant_id,
        COUNT(DISTINCT DATE(waktu_scan)) as total_days,
        SUM(CASE WHEN status = 'tepat_waktu' THEN 1 ELSE 0 END) as present_days,
        SUM(CASE WHEN status = 'terlambat' THEN 1 ELSE 0 END) as late_days
      FROM attendance_logs 
      WHERE DATE_FORMAT(waktu_scan, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
      GROUP BY teacher_id, tenant_id
    `);

    const results = [];

    for (const teacher of teachers) {
      const teacherStat = stats.find(s => s.teacher_id === teacher.id) || { total_days: 0, present_days: 0 };

      let score = 0;
      if (teacherStat.total_days > 0 && teacherStat.present_days > 0) {
        const rate = (teacherStat.present_days / teacherStat.total_days) * 100;
        if (rate >= 95) score = 5.0;
        else if (rate >= 90) score = 4.5;
        else if (rate >= 85) score = 4.0;
        else if (rate >= 80) score = 3.5;
        else if (rate >= 75) score = 3.0;
        else if (rate >= 70) score = 2.5;
        else if (rate >= 65) score = 2.0;
        else score = 1.0;
      }

      if (teacherStat.total_days > 0 && score > 0) {
        await db.query(`
          INSERT INTO evaluations (teacher_id, evaluator_id, tenant_id, score, category, notes, evaluation_date)
          VALUES (?, ?, ?, ?, 'kehadiran', ?, CURDATE())
          ON DUPLICATE KEY UPDATE score = VALUES(score), notes = VALUES(notes)
        `, [teacher.id, evaluator_id, teacher.tenant_id, score, `Otomatis: ${teacherStat.present_days}/${teacherStat.total_days} hari hadir (${teacher.nama_sekolah})`]);

        results.push({ id: teacher.id, score, nama: teacher.nama, sekolah: teacher.nama_sekolah });
      }
    }

    res.json({ success: true, message: `Berhasil menilai ${results.length} guru`, data: results });
  } catch (error) {
    console.error('Auto calculate error:', error);
    res.status(500).json({ success: false, message: 'Error auto calculating evaluations' });
  }
});

// GET /api/tenants - Public route for tenant list (for dropdowns)
router.get('/tenants', async (req, res) => {
  try {
    const rows = await db.query('SELECT tenant_id, nama_sekolah, tipe_unit FROM tenants ORDER BY nama_sekolah ASC');
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenants' });
  }
});

// GET /api/tenants/:id - Get tenant by ID with full info
router.get('/tenants/:id', authenticateToken, async (req, res) => {
  try {
    const [tenant] = await db.query(
      'SELECT *, tipe_unit FROM tenants WHERE tenant_id = ?',
      [req.params.id]
    );
    if (tenant) {
      res.json({ success: true, tenant: tenant });
    } else {
      res.status(404).json({ success: false, message: 'Tenant not found' });
    }
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenant' });
  }
});

// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;