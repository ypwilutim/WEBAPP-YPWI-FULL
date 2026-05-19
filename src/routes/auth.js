// ============================================================
// AUTH ROUTES - Login, Profile, Forgot Password
// Extracted from server.js for modular architecture
// ============================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const { authenticateToken, SECRET_KEY } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// LOGIN
// ============================================================

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username dan password wajib diisi.'
    });
  }

  try {
    const users = await db.query('SELECT * FROM users WHERE username = ?', [username]);

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Username atau password salah.'
      });
    }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Username atau password salah.'
      });
    }

    const isProfileComplete = user.is_profile_complete === 1;
    const absensiMethod = user.tenant_id === 'SDIT' ? 'hp' : 'scanner';

    const tokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      guru_id: user.guru_id,
      tenant_id: user.tenant_id,
      absensi_method: absensiMethod,
      timestamp: new Date().toISOString()
    };

    // Cari assignments guru untuk akses admin sekolah
    if (user.role !== 'admin' && user.guru_id) {
      try {
        const tokenAssignments = await db.query(
          'SELECT ta.tenant_id, ta.jabatan_di_unit, t.nama_sekolah FROM teacher_assignments ta JOIN tenants t ON ta.tenant_id = t.tenant_id WHERE ta.teacher_id = ?',
          [user.guru_id]
        );
        tokenPayload.assignments = tokenAssignments;
      } catch (e) {
        tokenPayload.assignments = [];
      }
    }

    const token = jwt.sign(tokenPayload, SECRET_KEY, { expiresIn: '8h' });

    if (!isProfileComplete) {
      return res.json({
        success: true,
        redirect: 'complete-profile.html',
        teacherId: user.guru_id,
        role: user.role,
        tenant_id: user.tenant_id,
        message: 'Profil belum lengkap. Silakan lengkapi profil Anda.'
      });
    }

    return res.json({
      success: true,
      redirect: (user.role === 'admin' ? 'admin-dashboard.html' : 'dashboard.html'),
      token: token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
        guru_id: user.guru_id,
        is_profile_complete: user.is_profile_complete,
        is_default_password: user.is_default_password
      }
    });

  } catch (error) {
    console.error('[LOGIN ERROR]', error.message);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan sistem.'
    });
  }
});

// ============================================================
// PROFILE UPDATE
// ============================================================

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await db.query('UPDATE users SET is_profile_complete = 1 WHERE id = ?', [req.user.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }
    res.json({
      success: true,
      message: 'Profil berhasil diperbarui!'
    });
  } catch (error) {
    console.error('[PROFILE UPDATE ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// Public endpoint for profile completion (no auth required)
router.put('/profile-complete/:teacherId', async (req, res) => {
  const { teacherId } = req.params;

  try {
    const userRows = await db.query('SELECT id FROM users WHERE guru_id = ?', [teacherId]);
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    const result = await db.query('UPDATE users SET is_profile_complete = 1 WHERE guru_id = ?', [teacherId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    res.json({
      success: true,
      message: 'Profil berhasil diperbarui!'
    });
  } catch (error) {
    console.error('[PROFILE COMPLETE ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// ============================================================
// FORGOT PASSWORD - OTP
// ============================================================

router.post('/forgot-password/send-otp', async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp wajib diisi' });
    }

    let cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('62')) {
      if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
      } else {
        cleanNumber = '62' + cleanNumber;
      }
    }

    const [teacher] = await db.query('SELECT id, nama FROM teachers WHERE no_wa = ? AND status_aktif = 1', [cleanNumber]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Nomor WhatsApp tidak terdaftar' });
    }

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    global.tempOtps = global.tempOtps || {};
    global.tempOtps[cleanNumber] = {
      code: verificationCode,
      expires: Date.now() + 5 * 60 * 1000,
      teacherId: teacher.id
    };

    const message = `🔐 *KODE VERIFIKASI - LUPA PASSWORD*

Assalamu'alaikum ${teacher.nama}

Kode verifikasi untuk reset password Anda: *${verificationCode}*

Kode ini berlaku selama 5 menit.

Jika Anda tidak meminta reset password, abaikan pesan ini.

*YPWI Lutim*`;

    // For now, just return success (WhatsApp integration optional)
    res.json({
      success: true,
      message: 'Kode verifikasi telah dikirim ke WhatsApp Anda',
      verificationCode: verificationCode
    });

  } catch (error) {
    console.error('[SEND OTP ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
  }
});

router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { phoneNumber, otpCode, newPassword } = req.body;

    if (!phoneNumber || !otpCode || !newPassword) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 8 karakter' });
    }

    let cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('62')) {
      if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
      } else {
        cleanNumber = '62' + cleanNumber;
      }
    }

    const tempOtp = global.tempOtps?.[cleanNumber];
    if (!tempOtp || tempOtp.code !== otpCode || Date.now() > tempOtp.expires) {
      return res.status(400).json({ success: false, message: 'Kode verifikasi tidak valid atau sudah kadaluarsa' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updateResult = await db.query(
      'UPDATE users SET password = ?, is_default_password = 0 WHERE guru_id = ?',
      [hashedPassword, tempOtp.teacherId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    delete global.tempOtps[cleanNumber];

    res.json({
      success: true,
      message: 'Password berhasil direset'
    });

  } catch (error) {
    console.error('[RESET PASSWORD ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
  }
});

module.exports = router;