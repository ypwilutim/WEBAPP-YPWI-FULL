// ============================================================
// ADMIN ROUTES - Extracted from server.js for modular architecture
// Includes: tenants, teachers, rules, locations, reports
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../../db');
const { authenticateToken, authenticateOperator, authenticateAdmin, verifyTenantAccess } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// MULTER CONFIG FOR TEACHER PHOTOS
// ============================================================

const teacherStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'teacher-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const teacherUpload = multer({
  storage: teacherStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Hanya file gambar yang diperbolehkan (JPG, PNG, GIF)'));
    }
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      return cb(new Error('Format file tidak didukung. Gunakan JPG, PNG, atau GIF'));
    }
    cb(null, true);
  }
});

// ============================================================
// TENANTS ROUTES
// ============================================================

// GET /api/admin/tenants - List all tenants with tipe_unit
router.get('/admin/tenants', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    let query = 'SELECT tenant_id, nama_sekolah, absensi_method, use_central_rules, latitude, longitude, COALESCE(location_radius, 100) as location_radius, location_name, tipe_unit FROM tenants';
    let params = [];
    if (tenantId) {
      query += ' WHERE tenant_id = ?';
      params.push(tenantId);
    }
    query += ' ORDER BY nama_sekolah ASC';
    const tenants = await db.query(query, params);
    res.json({ success: true, data: tenants });
  } catch (error) {
    console.error('Admin tenants error:', error);
    res.status(500).json({ success: false, message: 'Error fetching tenants' });
  }
});

// GET /api/admin/tenants/:tenantId - Get tenant by ID
router.get('/admin/tenants/:tenantId', authenticateOperator, async (req, res) => {
  try {
    if (req.user.role === 'guru' && req.user.assignments) {
      const allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
      if (!allowedTenants.includes(req.params.tenantId)) {
        return res.status(403).json({ success: false, message: 'Akses ditolak' });
      }
    }
    const [tenant] = await db.query('SELECT * FROM tenants WHERE tenant_id = ?', [req.params.tenantId]);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    res.json({ success: true, data: tenant });
  } catch (error) {
    console.error('Admin tenant detail error:', error);
    res.status(500).json({ success: false, message: 'Error fetching tenant' });
  }
});

// POST /api/admin/tenants - Create new tenant
router.post('/admin/tenants', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, nama_sekolah, absensi_method, tipe_unit } = req.body;
    if (!tenant_id || !nama_sekolah) {
      return res.status(400).json({ success: false, message: 'tenant_id dan nama_sekolah wajib diisi' });
    }
    if (!/^[a-zA-Z0-9_]{1,20}$/.test(tenant_id)) {
      return res.status(400).json({ success: false, message: 'Format tenant_id tidak valid' });
    }
    const existing = await db.query('SELECT tenant_id FROM tenants WHERE tenant_id = ?', [tenant_id]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Tenant ID sudah digunakan' });
    }
    await db.query(
      'INSERT INTO tenants (tenant_id, nama_sekolah, absensi_method, tipe_unit) VALUES (?, ?, ?, ?)',
      [tenant_id, nama_sekolah, absensi_method || 'personal', tipe_unit || 'sekolah']
    );
    res.json({ success: true, message: 'Tenant berhasil dibuat' });
  } catch (error) {
    console.error('Create tenant error:', error.message);
    res.status(500).json({ success: false, message: 'Error creating tenant' });
  }
});

// PUT /api/admin/tenants/:tenantId - Update tenant
router.put('/admin/tenants/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { latitude, longitude, location_radius, location_name, use_central_rules, tipe_unit } = req.body;

    if (req.user.role === 'guru' && req.user.assignments) {
      const allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
      if (!allowedTenants.includes(tenantId)) {
        return res.status(403).json({ success: false, message: 'Akses ditolak' });
      }
    }

    const updateFields = [];
    const updateValues = [];

    // --- BLOK PENYELAMAT KOORDINAT GEOFENCE ---
    if (latitude !== undefined && latitude !== null) {
      updateFields.push('latitude = ?');
      updateValues.push(latitude);
    }
    if (longitude !== undefined && longitude !== null) {
      updateFields.push('longitude = ?');
      updateValues.push(longitude);
    }
    if (location_radius !== undefined && location_radius !== null) {
      updateFields.push('location_radius = ?');
      updateValues.push(location_radius);
    }
    if (location_name !== undefined && location_name !== null) {
      updateFields.push('location_name = ?');
      updateValues.push(location_name);
    }
    // ------------------------------------------

    if (use_central_rules !== undefined) {
      updateFields.push('use_central_rules = ?');
      updateValues.push(use_central_rules ? 1 : 0);
    }
    if (tipe_unit !== undefined) {
      updateFields.push('tipe_unit = ?');
      updateValues.push(tipe_unit);
    }

    // Jika ada field yang dikirim untuk diupdate
    if (updateFields.length > 0) {
      updateValues.push(tenantId);
      const queryStr = `UPDATE tenants SET ${updateFields.join(', ')} WHERE tenant_id = ?`;
      console.log(`[SQL EXECUTE] ${queryStr} with values:`, updateValues); // Untuk mempermudah monitoring log Anda

      await db.query(queryStr, updateValues);
      res.json({ success: true, message: 'Tenant berhasil diupdate' });
    } else {
      res.json({ success: true, message: 'Tidak ada data baru yang diupdate' });
    }

  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ success: false, message: 'Error updating tenant' });
  }
});

// ============================================================
// RULES ROUTES (attendance_rules)
// ============================================================

// GET /api/admin/rules - List attendance rules
router.get('/admin/rules', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    let query = 'SELECT * FROM attendance_rules';
    let params = [];
    if (tenantId) {
      query += ' WHERE tenant_id = ?';
      params.push(tenantId);
    }
    query += ' ORDER BY tenant_id, tipe, jam_mulai';
    const rules = await db.query(query, params);
    res.json({ success: true, data: rules });
  } catch (error) {
    console.error('Admin rules error:', error);
    res.status(500).json({ success: false, message: 'Error fetching rules' });
  }
});

// POST /api/admin/rules - Create rule
router.post('/admin/rules', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari } = req.body;

    if (!tenant_id || !tipe || !jam_mulai || !jam_selesai || !status_log) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }

    if (!['Datang', 'Pulang'].includes(tipe)) {
      return res.status(400).json({ success: false, message: 'Tipe harus Datang atau Pulang' });
    }
    if (!['tepat_waktu', 'terlambat'].includes(status_log)) {
      return res.status(400).json({ success: false, message: 'Status log tidak valid' });
    }

    await db.query(
      'INSERT INTO attendance_rules (tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenant_id, tipe, jam_mulai, jam_selesai, keterangan || null, status_log, hari || null]
    );

    res.json({ success: true, message: 'Aturan berhasil dibuat' });
  } catch (error) {
    console.error('Create rule error:', error);
    res.status(500).json({ success: false, message: 'Error creating rule' });
  }
});

// PUT /api/admin/rules/:id - Update rule
router.put('/admin/rules/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari } = req.body;

    if (!tenant_id || !tipe || !jam_mulai || !jam_selesai || !status_log) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }

    const result = await db.query(
      'UPDATE attendance_rules SET tenant_id = ?, tipe = ?, jam_mulai = ?, jam_selesai = ?, keterangan = ?, status_log = ?, hari = ? WHERE id = ?',
      [tenant_id, tipe, jam_mulai, jam_selesai, keterangan || null, status_log, hari || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Rule tidak ditemukan' });
    }

    res.json({ success: true, message: 'Aturan berhasil diupdate' });
  } catch (error) {
    console.error('Update rule error:', error);
    res.status(500).json({ success: false, message: 'Error updating rule' });
  }
});

// DELETE /api/admin/rules/:id - Delete rule
router.delete('/admin/rules/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;
    const [rule] = await db.query('SELECT tenant_id FROM attendance_rules WHERE id = ?', [id]);
    if (!rule) {
      return res.status(404).json({ success: false, message: 'Rule tidak ditemukan' });
    }
    if (!verifyTenantAccess(req, rule.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }

    await db.query('DELETE FROM attendance_rules WHERE id = ?', [id]);
    res.json({ success: true, message: 'Aturan berhasil dihapus' });
  } catch (error) {
    console.error('Delete rule error:', error);
    res.status(500).json({ success: false, message: 'Error deleting rule' });
  }
});

// ============================================================
// LOCATIONS ROUTES
// ============================================================

// GET /api/admin/tenant-locations - List locations
router.get('/admin/tenant-locations', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    let query = 'SELECT tl.*, t.nama_sekolah, t.tipe_unit FROM tenant_locations tl JOIN tenants t ON tl.tenant_id = t.tenant_id';
    let params = [];
    if (tenantId) {
      query += ' WHERE tl.tenant_id = ?';
      params.push(tenantId);
    }
    query += ' ORDER BY tl.tenant_id, tl.location_name';
    const locations = await db.query(query, params);
    res.json({ success: true, data: locations });
  } catch (error) {
    console.error('Locations list error:', error.message);
    res.status(500).json({ success: false, message: 'Error fetching locations' });
  }
});

// POST /api/admin/tenant-locations - Create location
router.post('/admin/tenant-locations', authenticateOperator, async (req, res) => {
  try {
    let tenant_id = req.body.tenant_id;

    if (req.user.role === 'guru' && req.user.assignments) {
      const allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
      if (allowedTenants.length === 1) {
        tenant_id = allowedTenants[0];
      }
    }

    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }

    const { location_name, latitude, longitude, location_radius } = req.body;

    if (!tenant_id || !location_name) {
      return res.status(400).json({ success: false, message: 'Field wajib diisi' });
    }

    await db.query(
      'INSERT INTO tenant_locations (tenant_id, location_name, latitude, longitude, location_radius, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [tenant_id, location_name, latitude || null, longitude || null, location_radius || 100]
    );

    res.json({ success: true, message: 'Lokasi berhasil dibuat' });
  } catch (error) {
    console.error('Create location error:', error.message);
    res.status(500).json({ success: false, message: 'Error creating location' });
  }
});

// ============================================================
// TEACHERS ROUTES
// ============================================================

// GET /api/admin/teachers - List teachers with pagination
router.get('/admin/teachers', authenticateOperator, async (req, res) => {
  try {
    let tenantId = req.query.tenant_id;

    if (req.user.role === 'guru' && !tenantId) {
      const adminAssignments = (req.user.assignments || []).filter(a => {
        const roles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
        return roles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''));
      });
      if (adminAssignments.length === 1) {
        tenantId = adminAssignments[0].tenant_id;
      } else if (adminAssignments.length > 1) {
        return res.status(400).json({ success: false, message: 'Tentukan tenant_id' });
      }
    }

    let query = `
      SELECT t.id, t.nama, t.nik, t.nip, t.email, t.status_kepegawaian, t.status_aktif, t.no_wa,
             GROUP_CONCAT(DISTINCT CONCAT(ta.tenant_id, ':', ta.jabatan_di_unit)) as assignments
      FROM teachers t
      LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
      WHERE t.status_aktif = 1
    `;
    let params = [];

    if (tenantId) {
      query += ' AND EXISTS (SELECT 1 FROM teacher_assignments ta2 WHERE ta2.teacher_id = t.id AND ta2.tenant_id = ?)';
      params.push(tenantId);
    }

    query += ' GROUP BY t.id ORDER BY t.nama ASC LIMIT 100';
    const teachers = await db.query(query, params);
    res.json({ success: true, data: teachers });
  } catch (error) {
    console.error('Admin teachers error:', error);
    res.status(500).json({ success: false, message: 'Error fetching teachers' });
  }
});

// GET /api/admin/teachers/:id - Get teacher by ID
router.get('/admin/teachers/:id', authenticateOperator, async (req, res) => {
  try {
    const [teacher] = await db.query(
      'SELECT id, nama, nik, tempat_lahir, tanggal_lahir, jenis_kelamin, alamat, no_wa, email, status_kepegawaian, tmt, nip, scan_id, link_foto, status_aktif FROM teachers WHERE id = ? AND status_aktif = 1',
      [req.params.id]
    );
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }
    const assignmentRows = await db.query('SELECT tenant_id, jabatan_di_unit FROM teacher_assignments WHERE teacher_id = ?', [req.params.id]);
    teacher.assignments = assignmentRows;
    res.json({ success: true, data: teacher });
  } catch (error) {
    console.error('Get teacher error:', error.message);
    res.status(500).json({ success: false, message: 'Error fetching teacher' });
  }
});

// ============================================================
// DASHBOARD ROUTES
// ============================================================

// GET /api/dashboard - User dashboard
router.get('/dashboarda', authenticateToken, async (req, res) => {
  try {
    let attendanceQuery;
    if (req.user.role === 'admin') {
      attendanceQuery = await db.query('SELECT COUNT(*) as total FROM attendance_logs');
    } else {
      attendanceQuery = await db.query('SELECT COUNT(*) as total FROM attendance_logs WHERE teacher_id = ?', [req.user.guru_id]);
    }

    res.json({
      success: true,
      data: {
        totalAbsensi: attendanceQuery[0]?.total || 0,
        user: req.user
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching dashboard' });
  }
});

// GET /api/admin/summary - Admin dashboard summary
router.get('/admin/summary', authenticateOperator, async (req, res) => {
  try {
    const totalTeachers = await db.query('SELECT COUNT(*) as count FROM teachers WHERE status_aktif = 1');
    const activeToday = await db.query(
      'SELECT COUNT(DISTINCT teacher_id) as count FROM attendance_logs WHERE DATE(waktu_scan) = CURDATE()'
    );
    const lateToday = await db.query(
      'SELECT COUNT(*) as count FROM attendance_logs WHERE DATE(waktu_scan) = CURDATE() AND status = "terlambat"'
    );
    const totalLocations = await db.query('SELECT COUNT(*) as count FROM tenant_locations WHERE is_active = 1');

    res.json({
      success: true,
      data: {
        totalTeachers: totalTeachers[0].count,
        activeToday: activeToday[0].count,
        lateToday: lateToday[0].count,
        totalLocations: totalLocations[0].count
      }
    });
  } catch (error) {
    console.error('Admin summary error:', error);
    res.status(500).json({ success: false, message: 'Error fetching summary' });
  }
});

module.exports = router;