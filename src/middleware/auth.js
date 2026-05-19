// ============================================================
// AUTH MIDDLEWARE - Authentication & Authorization
// Extracted from server.js for modular architecture
// ============================================================

const jwt = require('jsonwebtoken');
const db = require('../../db');

const SECRET_KEY = process.env.JWT_SECRET || 'ypwi-secret-key-2026';

// ============================================================
// MIDDLEWARE
// ============================================================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Token tidak ditemukan.'
    });
  }

  jwt.verify(token, SECRET_KEY, async (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Akses ditolak. Token tidak valid.'
      });
    }
    req.user = user;

    // Load assignments for role-based access (only for guru users with guru_id)
    if (user.guru_id) {
      try {
        const assignments = await db.query(
          'SELECT ta.tenant_id, ta.jabatan_di_unit, t.nama_sekolah FROM teacher_assignments ta JOIN tenants t ON ta.tenant_id = t.tenant_id WHERE ta.teacher_id = ? AND ta.status_aktif = 1',
          [user.guru_id]
        );
        req.user.assignments = assignments;
      } catch (error) {
        req.user.assignments = [];
      }
    } else {
      req.user.assignments = [];
    }

    next();
  });
};

const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. Token not found.' });
  }
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Access denied. Token not valid.' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied. Admin role required.' });
    }
    req.user = user;
    next();
  });
};

const authenticateOperator = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. Token not found.' });
  }
  jwt.verify(token, SECRET_KEY, async (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Access denied. Token not valid.' });
    }

    // Load assignments for role-based access (needed for both admin and guru)
    // Prefer assignments from JWT if present (backward compatible with old tokens)
    if (!user.assignments || user.assignments.length === 0) {
      // Only load assignments if user has guru_id (not for pure admin users)
      if (user.guru_id) {
        try {
          const assignments = await db.query(
            'SELECT ta.tenant_id, ta.jabatan_di_unit, t.nama_sekolah FROM teacher_assignments ta JOIN tenants t ON ta.tenant_id = t.tenant_id WHERE ta.teacher_id = ? AND ta.status_aktif = 1',
            [user.guru_id]
          );
          user.assignments = assignments;
        } catch (error) {
          user.assignments = [];
        }
      } else {
        user.assignments = [];
      }
    }
    req.user = user;

    // Admin boleh semua
    if (user.role === 'admin') {
      return next();
    }
    // Guru dengan assignment admin/TU/operator: boleh akses
    if (user.role === 'guru' && user.assignments) {
      const adminRoles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
      const hasAdminRole = user.assignments.some(a =>
        adminRoles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
      );
      if (hasAdminRole) {
        return next();
      }
    }
    return res.status(403).json({ success: false, message: 'Akses ditolak. Peran admin/operator diperlukan.' });
  });
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getTenantFilter(tenantId) {
  if (tenantId) {
    return { where: 'tenant_id = ?', params: [tenantId] };
  }
  return { where: '', params: [] };
}

function verifyTenantAccess(req, requestedTenantId) {
  if (!requestedTenantId) return true;
  const userRole = req.user?.role;
  const assignments = req.user?.assignments || [];

  if (userRole === 'admin') return true;

  if (userRole === 'guru' && assignments.length > 0) {
    const adminRoles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
    const allowedTenants = assignments
      .filter(a => adminRoles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, '')))
      .map(a => a.tenant_id);

    if (allowedTenants.includes(requestedTenantId)) return true;
  }

  return false;
}

// Check if current day matches rule days
function isDayMatch(ruleHari, currentDay) {
  if (!ruleHari || ruleHari.trim() === '') return true;

  const rule = ruleHari.toLowerCase().trim();
  const day = currentDay.toLowerCase().trim();

  if (rule.includes('-')) {
    const [start, end] = rule.split('-').map(d => d.trim());
    const days = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
    const startIdx = days.indexOf(start);
    const endIdx = days.indexOf(end);
    const currentIdx = days.indexOf(day);
    if (startIdx === -1 || endIdx === -1 || currentIdx === -1) return false;
    return currentIdx >= startIdx && currentIdx <= endIdx;
  }

  const ruleDays = rule.split(',').map(d => d.trim());
  return ruleDays.includes(day);
}

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Format Islamic message with proper greeting
function formatIslamicMessage(nama, jenis_kelamin, message) {
  const panggilan = jenis_kelamin === 'P' ? 'Ustadzah' : 'Ustadz';
  return `Assalamu'alaikum ${panggilan} ${nama}\n\n${message}\n\nBarakallahu fiikum,\n*YPWI Lutim*`;
}

module.exports = {
  authenticateToken,
  authenticateAdmin,
  authenticateOperator,
  verifyTenantAccess,
  isDayMatch,
  calculateDistance,
  formatIslamicMessage,
  getTenantFilter,
  SECRET_KEY
};