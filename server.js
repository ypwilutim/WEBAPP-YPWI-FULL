require('dotenv').config();

console.log('Loading environment variables...');
console.log('WHATSAPP_ENDPOINT:', process.env.WHATSAPP_ENDPOINT ? 'LOADED' : 'NOT FOUND');
console.log('WHATSAPP_DEVICE_ID:', process.env.WHATSAPP_DEVICE_ID ? 'LOADED' : 'NOT FOUND');

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const axios = require('axios');
const PDFKit = require('pdfkit');
const db = require('./db');

// Native fetch is available in modern Node.js, no import needed

// Helper function to check if current day matches rule days
function isDayMatch(ruleHari, currentDay) {
  if (!ruleHari || ruleHari.trim() === '') return true; // All days if empty

  const rule = ruleHari.toLowerCase().trim();
  const day = currentDay.toLowerCase().trim();

  // Handle range: 'senin-kamis'
  if (rule.includes('-')) {
    const [start, end] = rule.split('-').map(d => d.trim());
    const days = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
    const startIdx = days.indexOf(start);
    const endIdx = days.indexOf(end);
    const currentIdx = days.indexOf(day);

    if (startIdx === -1 || endIdx === -1 || currentIdx === -1) return false;
    return currentIdx >= startIdx && currentIdx <= endIdx;
  }

  // Handle multiple days: 'senin,rabu,kamis'
  const ruleDays = rule.split(',').map(d => d.trim());
  return ruleDays.includes(day);
}

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || 'ypwi-secret-key-2026';

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

// Environment check
console.log('🔧 Environment Configuration:');
console.log('   WHATSAPP_ENDPOINT:', process.env.WHATSAPP_ENDPOINT ? '✅ LOADED' : '❌ MISSING');
console.log('   WHATSAPP_DEVICE_ID:', process.env.WHATSAPP_DEVICE_ID ? '✅ LOADED' : '❌ MISSING');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ LOADED' : '❌ MISSING');
console.log('   DB_HOST:', process.env.DB_HOST ? '✅ LOADED' : '❌ MISSING');
console.log('   PORT:', PORT);
console.log('');

// Security middleware - disabled CSP for development with IP access
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for IP access
  crossOriginOpenerPolicy: false, // Disable COOP for IP access
  crossOriginEmbedderPolicy: false // Disable COEP for IP access
}));

// Custom headers to prevent HTTPS redirect and allow IP access
app.use((req, res, next) => {
  // Prevent HTTPS redirect by setting appropriate headers
  res.setHeader('Strict-Transport-Security', 'max-age=0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');

  // Allow all origins for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  next();
});

// Preflight requests are handled by the CORS middleware above

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// app.use(limiter);
// app.use('/api/auth/login', authLimiter);

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    for (let key in obj) {
      if (typeof obj[key] === 'string') {
        // Trim whitespace only - do NOT HTML-encode (breaks JSON data)
        obj[key] = obj[key].trim();
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitize(obj[key]);
      }
    }
  };

  if (req.body) sanitize(req.body);
  if (req.query) sanitize(req.query);
  if (req.params) sanitize(req.params);

  next();
};

// Only apply sanitize to non-file-upload routes
app.use('/api', sanitizeInput);

// Error handling for multer and generic errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File terlalu besar. Maksimal 5MB.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Terlalu banyak file. Maksimal 1 file.'
      });
    }
  }

  if (error.message && (error.message.includes('Only image files') || error.message.includes('file gambar') || error.message.includes('Format file'))) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  // Generic error handler - log full error for debugging
  console.error('[UNHANDLED ERROR]', error.message);
  console.error(error.stack);
  return res.status(500).json({
    success: false,
    message: 'Internal server error: ' + error.message
  });
});

// Configure multer for file uploads
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
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1 // Maximum 1 file
  },
  fileFilter: (req, file, cb) => {
    // Check if file is an image
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Hanya file gambar yang diperbolehkan (JPG, PNG, GIF)'));
    }

    // Check file extension
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      return cb(new Error('Format file tidak didukung. Gunakan JPG, PNG, atau GIF'));
    }

    cb(null, true);
  }
});

app.use(cors());
app.use(express.static('public'));

const logFilePath = path.join(__dirname, 'logs', 'app.log');
// Ensure logs directory exists
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'));
}
const logger = {
   request: (req, message = '') => {
     const timestamp = new Date().toISOString();
     const { method, url, headers, body } = req;
     const safeBody = { ...body };
     if (safeBody.password) safeBody.password = '[HIDDEN]';
     const logMessage = `[${timestamp}] 🌍 REQUEST  | ${method.padEnd(6)} | ${url.padEnd(40)} | Body: ${JSON.stringify(safeBody)}`;
     console.log(logMessage);
     fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
   },
   response: (req, res, statusCode) => {
     const timestamp = new Date().toISOString();
     const logMessage = `[${timestamp}] 📤 RESPONSE | ${req.method.padEnd(6)} | ${req.url.padEnd(40)} | Status: ${statusCode}`;
     console.log(logMessage);
     fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
   },
   loginDebug: {
     receivedData: (data) => {
       const timestamp = new Date().toISOString();
       const safeData = { ...data };
       if (safeData.password) safeData.password = '[HIDDEN]';
        const logMessage = `[${timestamp}] 🔐 LOGIN_DEBUG | [1/3] Data received from body: ${JSON.stringify(safeData)}`;
       console.log(logMessage);
       fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
     },
     queryResult: (user) => {
       const timestamp = new Date().toISOString();
       let logMessage;
       if (user) {
          logMessage = `[${timestamp}] 🔐 LOGIN_DEBUG | [2/3] User found in DB: ${JSON.stringify({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id, guru_id: user.guru_id, hasPassword: !!user.password, is_profile_complete: user.is_profile_complete })}`;
       } else {
         logMessage = `[${timestamp}] 🔐 LOGIN_DEBUG | [2/3] No records found`;
       }
       console.log(logMessage);
       fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
     },
     passwordCheck: (isValid) => {
       const timestamp = new Date().toISOString();
       const logMessage = `[${timestamp}] 🔐 LOGIN_DEBUG | [3/3] Password comparison result: ${isValid ? '✅ MATCH' : '❌ MISMATCH'}`;
       console.log(logMessage);
       fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
     }
   },
   error: (error, context = '') => {
     const timestamp = new Date().toISOString();
     const logMessage = `\n[${timestamp}] ❌ ERROR    | Context: ${context}\n[${timestamp}] ❌ ERROR    | Message: ${error.message}\n[${timestamp}] ❌ ERROR    | Stack Trace:\n${error.stack}\n`;
     console.error(logMessage);
     fs.appendFileSync(logFilePath, logMessage + '\n', 'utf8');
   },
 };

// Request logging middleware
app.use((req, res, next) => {
  logger.request(req);
  const originalSend = res.send;
  res.send = function(body) {
    logger.response(req, res, res.statusCode);
    return originalSend.call(this, body);
  };
  next();
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Token tidak ditemukan.'
    });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Akses ditolak. Token tidak valid.'
      });
    }
    req.user = user;
    next();
  });
};

// Admin-only middleware
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

// Operator (guru/TU) middleware: mengizinkan admin DAN guru dengan assignment admin/TU/operator
const authenticateOperator = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. Token not found.' });
  }
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Access denied. Token not valid.' });
    }
    // Admin boleh semua
    if (user.role === 'admin') {
      req.user = user;
      return next();
    }
    // Guru dengan assignment admin/TU/operator/ta: boleh akses
    if (user.role === 'guru' && user.assignments) {
      const adminRoles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
      const hasAdminRole = user.assignments.some(a =>
        adminRoles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
      );
      if (hasAdminRole) {
        req.user = user;
        return next();
      }
    }
    return res.status(403).json({ success: false, message: 'Akses ditolak. Peran admin/operator diperlukan.' });
  });
};

// Helper: Build tenant filter untuk query SQL
function getTenantFilter(tenantId) {
  if (tenantId) {
    return { where: 'tenant_id = ?', params: [tenantId] };
  }
  return { where: '', params: [] };
}

// Helper: Verify tenant access untuk operators
function verifyTenantAccess(req, requestedTenantId) {
  if (!requestedTenantId) return true; // Admin pusat: akses semua
  const userRole = req.user?.role;
  const assignments = req.user?.assignments || [];

  // Super admin boleh semua
  if (userRole === 'admin') return true;

  // Guru dengan assignment admin/TU/operator/ta: cek apakah tenant_id ada di assignment-nya
  if (userRole === 'guru' && assignments.length > 0) {
    const adminRoles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
    const allowedTenants = assignments
      .filter(a => adminRoles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, '')))
      .map(a => a.tenant_id);

    if (allowedTenants.includes(requestedTenantId)) return true;
  }

  return false;
}

// WhatsApp integration using Whacenter
async function sendWhatsAppMessage(number, message) {
  if (process.env.WHATSAPP_ENABLED !== 'true') {
    console.log('📤 WhatsApp disabled, skipping message to:', number);
    return { success: true, message: 'WhatsApp disabled' };
  }

  console.log('📤 Sending WhatsApp message to:', number);

  try {
    // Ensure number starts with country code (Indonesia)
    let cleanNumber = number.replace(/\D/g, ''); // Remove non-digits

    // Add country code if not present
    if (!cleanNumber.startsWith('62')) {
      if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
      } else {
        cleanNumber = '62' + cleanNumber;
      }
    }

    console.log(`[WHATSAPP] Sending to ${cleanNumber}: ${message.substring(0, 50)}...`);

    const params = new URLSearchParams();
    params.append('device_id', process.env.WHATSAPP_DEVICE_ID);
    params.append('number', cleanNumber);
    params.append('message', message);

    const endpoint = process.env.WHATSAPP_ENDPOINT;
    console.log('📤 Sending WhatsApp to:', endpoint);
    console.log('📤 Params:', { device_id: process.env.WHATSAPP_DEVICE_ID, number: cleanNumber, message: message.substring(0, 100) + '...' });

    const response = await axios.post(endpoint, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000  // 5 second timeout
    });

    console.log('Response Status:', response.status);
    console.log('Response Data:', response.data);

    if (response.status === 200 && response.data.status === true) {
      console.log('✅ SUCCESS: WhatsApp message sent!');
      console.log('Message ID:', response.data.data?.id);
      return { success: true, message: 'Message sent successfully', data: response.data };
    } else {
      console.log('❌ FAILED: WhatsApp message not sent');
      console.log('Error details:', response.data);
      return { success: false, message: 'Failed to send message: ' + (response.data.message || response.data.error || 'Unknown error'), data: response.data };
    }

  } catch (error) {
    console.error('❌ NETWORK ERROR:', error.message);
    console.error('Full error:', error);
    return { success: false, message: `Network error: ${error.message}` };
  }
}

// Test route
app.get('/api/test', (req, res) => {
  console.log('[DEBUG] /api/test called');
  res.json({ success: true, message: 'Test route works', timestamp: new Date().toISOString() });
});

// Login route
app.post('/api/auth/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username dan password wajib diisi.'
    });
  }

  // Validate email format (disabled to allow non-email usernames for admin)
  // if (!validator.isEmail(username)) {
  //   return res.status(400).json({
  //     success: false,
  //     message: 'Format email tidak valid.'
  //   });
// }

try {
    logger.loginDebug.receivedData({ username, password: '[HIDDEN]' });

     // Validate email format (optional, comment out to allow non-email usernames)
     // if (!validator.isEmail(username)) {
     //   return res.status(400).json({
     //     success: false,
     //     message: 'Format email tidak valid.'
     //   });
     // }

     const users = await db.query('SELECT * FROM users WHERE username = ?', [username]);
     logger.loginDebug.queryResult(users[0]);

     if (users.length === 0) {
       return res.status(401).json({
         success: false,
         message: 'Username atau password salah.'
       });
     }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    logger.loginDebug.passwordCheck(isPasswordValid);

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
         var tokenAssignments = await db.query(
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
    logger.error(error, 'Login route');
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan sistem.'
    });
  }
});

// Profile route
app.put('/api/profile', authenticateToken, async (req, res) => {
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
    logger.error(error, 'Update profile route');
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// Public endpoint for profile completion (no auth required)
app.put('/api/profile-complete/:teacherId', async (req, res) => {
  const { teacherId } = req.params;

  try {
    // Find user by guru_id (teacher_id)
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
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error updating profile' });
  }
});

// Public search endpoint for teachers (no auth required)
app.get('/api/search/teachers', async (req, res) => {
  try {
    const searchTerm = req.query.q || '';
    const limit = parseInt(req.query.limit) || 50;

    let query = `
      SELECT
        t.id, t.nama, t.nik, t.nip, t.email, t.status_aktif,
        CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as has_user,
        GROUP_CONCAT(DISTINCT CONCAT(ta.tenant_id, ':', ta.jabatan_di_unit, ':', tn.nama_sekolah)) as assignments
      FROM teachers t
      LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
      LEFT JOIN tenants tn ON ta.tenant_id = tn.tenant_id
      LEFT JOIN users u ON t.email = u.username AND u.role = 'guru'
      WHERE t.status_aktif = 1
    `;
    let params = [];

    if (searchTerm) {
      query += ' AND t.nama LIKE ?';
      params.push(`%${searchTerm}%`);
    }

    query += ' GROUP BY t.id ORDER BY t.nama ASC LIMIT ?';
    params.push(limit);

    const teachers = await db.query(query, params);

    // Format assignments
    const formattedTeachers = teachers.map(teacher => ({
      ...teacher,
      assignments: teacher.assignments ? teacher.assignments.split(',').map(a => {
        const [tenant_id, jabatan, nama_sekolah] = a.split(':');
        return { tenant_id, jabatan_di_unit: jabatan, nama_sekolah };
      }) : []
    }));

    res.json({ success: true, data: formattedTeachers });
  } catch (error) {
    console.error('Public teacher search error:', error);
    res.status(500).json({ success: false, message: 'Error searching teachers' });
  }
});

// Public endpoint for WhatsApp notifications (used in profile completion)
app.post('/api/send-whatsapp-public', async (req, res) => {
  try {
    const { number, message, type, nama, jenis_kelamin, teacherId } = req.body;

    if (!number || !message) {
      return res.status(400).json({ success: false, message: 'Number and message are required' });
    }

    // Format message with Islamic etiquette if nama and jenis_kelamin provided
    let finalMessage = message;
    if (nama && jenis_kelamin) {
      finalMessage = formatIslamicMessage(nama, jenis_kelamin, message);
    }

    const result = await sendWhatsAppMessage(number, finalMessage);

    // Log the notification
    console.log(`[WHATSAPP NOTIFICATION] ${type || 'general'} - ${number}: ${result.success ? 'SUCCESS' : 'FAILED'}`);

    res.json({
      success: result.success,
      message: result.message
    });
  } catch (error) {
    console.error('[WHATSAPP NOTIFICATION ERROR]', error.message);
    console.error(error.stack);
    res.status(500).json({ success: false, message: 'Failed to send WhatsApp notification' });
  }
});

  // Test endpoint
  app.get('/api/test-history', function(req, res) {
    res.json({ success: true, message: 'Test endpoint working' });
  });

  // Test teacher completion progress (bypass auth for testing)
  app.get('/api/test-teacher-progress', async (req, res) => {
    try {
      // Get all active teachers with their completion data
      const teachers = await db.query(`
        SELECT
          t.id,
          t.nama,
          t.nik,
          t.nip,
          t.email,
          t.tempat_lahir,
          t.tanggal_lahir,
          t.jenis_kelamin,
          t.alamat,
          t.no_wa,
          t.status_kepegawaian,
          t.tmt,
          COUNT(ta.teacher_id) as assignment_count,
          GROUP_CONCAT(DISTINCT ta.jabatan_di_unit) as jabatan_list,
          GROUP_CONCAT(DISTINCT tn.nama_sekolah) as sekolah_list
        FROM teachers t
        LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
        LEFT JOIN tenants tn ON ta.tenant_id = tn.tenant_id
        WHERE t.status_aktif = 1
        GROUP BY t.id
        ORDER BY t.nama ASC
        LIMIT 5
      `);

      console.log('Raw teachers data:', teachers);

      // Calculate completion percentage for each teacher
      const completionData = teachers.map(teacher => {
        // Define fields to check (excluding system fields and NIY if exists)
        const fieldsToCheck = [
          'nama', 'nik', 'nip', 'email', 'tempat_lahir', 'tanggal_lahir',
          'jenis_kelamin', 'alamat', 'no_wa', 'status_kepegawaian', 'tmt'
        ];

        let filledFields = 0;
        let totalFields = fieldsToCheck.length;

        // Check each field
        fieldsToCheck.forEach(field => {
          if (teacher[field] && teacher[field].toString().trim() !== '') {
            filledFields++;
          }
        });

        // Bonus for having assignments (minimum 1)
        const hasAssignments = teacher.assignment_count > 0;
        if (hasAssignments) {
          filledFields += 1; // Bonus point for assignments
          totalFields += 1;
        }

        // Calculate percentage
        const percentage = Math.round((filledFields / totalFields) * 100);

        return {
          id: teacher.id,
          nama: teacher.nama,
          filled_fields: filledFields,
          total_fields: totalFields,
          has_assignments: hasAssignments,
          completion_percentage: percentage
        };
      });

      console.log('Calculated completion data:', completionData);

      res.json({
        success: true,
        message: 'Teacher completion progress test endpoint',
        data: completionData
      });
    } catch (error) {
      console.error('Test teacher completion progress error:', error);
      res.status(500).json({ success: false, message: 'Error testing teacher completion progress' });
    }
  });

  // Simple test endpoint for teacher progress
  app.get('/api/test-progress-simple', async (req, res) => {
    try {
      const count = await db.query('SELECT COUNT(*) as count FROM teachers WHERE status_aktif = 1');
      res.json({
        success: true,
        message: 'Simple teacher count test',
        teacher_count: count[0].count,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Simple test error:', error);
      res.status(500).json({ success: false, message: 'Database error' });
    }
  });

// Dashboard route
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    console.log('Dashboard req.user:', req.user);
    console.log('guru_id value:', req.user.guru_id, 'id value:', req.user.id, 'role:', req.user.role);

    let userQuery, attendanceQuery, todayRecords;
    if (req.user.role === 'admin') {
      userQuery = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
      attendanceQuery = await db.query('SELECT COUNT(*) as total FROM attendance_logs');
      todayRecords = await db.query('SELECT jenis FROM attendance_logs WHERE DATE(waktu_scan) = CURDATE()');
    } else {
      userQuery = await db.query('SELECT * FROM users WHERE guru_id = ?', [req.user.guru_id]);
      attendanceQuery = await db.query('SELECT COUNT(*) as total FROM attendance_logs WHERE teacher_id = ?', [req.user.guru_id]);
      todayRecords = await db.query('SELECT jenis FROM attendance_logs WHERE teacher_id = ? AND DATE(waktu_scan) = CURDATE()', [req.user.guru_id]);
    }

    console.log('todayRecords:', todayRecords);
    const hasMasuk = todayRecords.some(r => r.jenis === 'masuk');
    const hasPulang = todayRecords.some(r => r.jenis === 'pulang');

    let absensiToday;
    if (hasMasuk && hasPulang) {
      absensiToday = 'Sudah absen lengkap';
    } else if (hasMasuk) {
      absensiToday = 'Sudah absen masuk';
    } else {
      absensiToday = 'Belum absen';
    }

    console.log('Dashboard user query result:', userQuery);
    console.log('User[0]:', userQuery[0]);
    console.log('hasMasuk:', hasMasuk, 'hasPulang:', hasPulang, 'absensiToday:', absensiToday);

    res.json({
      success: true,
      data: {
        totalAbsensi: attendanceQuery[0]?.total || 0,
        absensiToday: absensiToday,
        hasMasuk: hasMasuk,
        hasPulang: hasPulang,
        user: userQuery[0]
      }
    });
  } catch (error) {
    logger.error(error, 'Dashboard route');
    res.status(500).json({ success: false, message: 'Error fetching dashboard data' });
  }
});

// Get teacher profile completion progress by tenant
app.get('/api/admin/teacher-progress', authenticateOperator, async (req, res) => {
  try {
    // Only admin or operator with admin/TU role can see progress
    if (req.user.role !== 'admin') {
      if (req.user.assignments && req.user.assignments.length > 0) {
        const adminRoles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha', 'admin'];
        const hasAdminRole = req.user.assignments.some(a =>
          adminRoles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
        );
        if (!hasAdminRole) {
          return res.status(403).json({ success: false, message: 'Akses ditolak. Anda tidak memiliki peran admin/TU.' });
        }
      } else {
        return res.status(403).json({ success: false, message: 'Akses ditolak. Operator tanpa peran admin/TU tidak dapat mengakses data ini.' });
      }
    }

    // Get all tenants with teacher count and completion stats
    const tenants = await db.query(`
      SELECT
        t.tenant_id,
        t.nama_sekolah,
        COUNT(DISTINCT ta.teacher_id) as total_guru,
        COUNT(DISTINCT CASE WHEN u.is_profile_complete = 1 THEN ta.teacher_id END) as guru_lengkap,
        ROUND(
          (COUNT(DISTINCT CASE WHEN u.is_profile_complete = 1 THEN ta.teacher_id END) * 100.0) /
          NULLIF(COUNT(DISTINCT ta.teacher_id), 0),
          1
        ) as persentase_kelengkapan
      FROM tenants t
      LEFT JOIN teacher_assignments ta ON t.tenant_id = ta.tenant_id
      LEFT JOIN users u ON ta.teacher_id = u.guru_id
      GROUP BY t.tenant_id, t.nama_sekolah
      ORDER BY persentase_kelengkapan ASC, t.nama_sekolah ASC
    `);

    console.log('Teacher progress query result:', tenants);

    res.json({
      success: true,
      data: tenants
    });
  } catch (error) {
    console.error('Teacher progress error:', error);
    res.status(500).json({ success: false, message: 'Error fetching teacher progress' });
  }
});

// Attendance route
app.post('/api/attendance', authenticateToken, selfieUpload.single('selfie'), async (req, res) => {
  try {
    const { jenis, metode, latitude, longitude, dinas_luar, kegiatan_dinas } = req.body;
    const currentTime = new Date().toTimeString().slice(0, 8);
    let selfie_url = null;
    let is_dinas_luar = dinas_luar === 'true' || dinas_luar === true;
    let tenant_id = req.user.tenant_id; // Default to assigned tenant

    if (req.file) {
      selfie_url = req.file.path;
    }

    // Validate location if coordinates provided
    if (latitude && longitude) {
      try {
        const userLat = parseFloat(latitude);
        const userLng = parseFloat(longitude);

        // Get all tenant locations
        const allLocations = await db.query(
          'SELECT tl.*, t.nama_sekolah FROM tenant_locations tl JOIN tenants t ON tl.tenant_id = t.tenant_id WHERE tl.latitude IS NOT NULL AND tl.longitude IS NOT NULL AND tl.is_active = 1'
        );

        let withinAssigned = false;
        let withinOther = false;
        let assignedLocation = null;
        let otherLocation = null;

        // Check assigned tenant locations first
        const assignedLocations = await db.query(
          'SELECT tl.*, t.nama_sekolah FROM tenant_locations tl JOIN tenants t ON tl.tenant_id = t.tenant_id JOIN teacher_assignments ta ON t.tenant_id = ta.tenant_id WHERE ta.teacher_id = ? AND tl.latitude IS NOT NULL AND tl.longitude IS NOT NULL AND tl.is_active = 1',
          [req.user.guru_id]
        );

        for (const location of assignedLocations) {
          const distance = calculateDistance(userLat, userLng, parseFloat(location.latitude), parseFloat(location.longitude));
          const radius = location.location_radius || 100;
          if (distance * 1000 <= radius) {
            withinAssigned = true;
            assignedLocation = location;
            break;
          }
        }

        // If not within assigned locations, check other tenant locations
        if (!withinAssigned) {
          for (const location of allLocations) {
            // Skip locations of assigned tenants
            if (assignedLocations.some(a => a.tenant_id === location.tenant_id)) continue;

            const distance = calculateDistance(userLat, userLng, parseFloat(location.latitude), parseFloat(location.longitude));
            const radius = location.location_radius || 100;
            if (distance * 1000 <= radius) {
              withinOther = true;
              otherLocation = location;
              tenant_id = location.tenant_id; // Change tenant to the location where they are
              is_dinas_luar = true;
              break;
            }
          }
        }

        console.log(`[LOCATION VALIDATION] User at ${userLat},${userLng}`);
        if (withinAssigned) {
          console.log(`[LOCATION VALIDATION] ✅ Within assigned location: ${assignedLocation.location_name} (${assignedLocation.nama_sekolah})`);
        } else if (withinOther) {
          console.log(`[LOCATION VALIDATION] ✅ Within other location (dinas luar): ${otherLocation.location_name} (${otherLocation.nama_sekolah})`);
        } else {
          return res.status(403).json({
            success: false,
            message: 'Absensi gagal! Anda berada di luar radius lokasi semua unit sekolah.'
          });
        }

      } catch (locationError) {
        console.error('[LOCATION VALIDATION] Error validating location:', locationError);
        // Continue with attendance if location validation fails
      }
    } else {
      console.log(`[LOCATION VALIDATION] No GPS coordinates provided`);
    }

    let rules = [];
    // Check if tenant uses central rules
    let rulesTenantId = req.user.tenant_id;
    try {
      const [tenantData] = await db.query('SELECT use_central_rules FROM tenants WHERE tenant_id = ?', [req.user.tenant_id]);
      if (tenantData && tenantData.use_central_rules) {
        rulesTenantId = 'YPWILUTIM';
        console.log(`[ATTENDANCE] Using central rules (YPWILUTIM) for tenant ${req.user.tenant_id}`);
      }
    } catch (tenantError) {
      console.log('[ATTENDANCE] Could not check central rules setting, using tenant rules');
    }

    // Get current day for rule filtering
    const currentDay = new Date().toLocaleDateString('id-ID', { weekday: 'long' }).toLowerCase();

    try {
      // Get all potential rules and filter by day in JavaScript
      const allRules = await db.query(
        'SELECT status_log, hari, jam_mulai FROM attendance_rules WHERE tenant_id = ? AND tipe = ? AND ? BETWEEN jam_mulai AND jam_selesai ORDER BY jam_mulai DESC',
        [rulesTenantId, jenis === 'masuk' ? 'Datang' : 'Pulang', currentTime]
      );

      // Filter rules that match the current day
      const matchingRules = allRules.filter(rule => isDayMatch(rule.hari, currentDay));

      // Take the first matching rule (earliest jam_mulai)
      rules = matchingRules.length > 0 ? [matchingRules[0]] : [];
    } catch (dbError) {
      console.log('[ATTENDANCE] attendance_rules table not found or error, using default status');
      rules = []; // Fallback to empty array
    }

    const status = (rules && rules.length > 0) ? rules[0].status_log : 'terlambat';

    const result = await db.query(
      'INSERT INTO attendance_logs (teacher_id, tenant_id, waktu_scan, jenis, metode, status, dinas_luar, kegiatan_dinas, selfie_url, latitude, longitude) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.guru_id, tenant_id, jenis, metode || 'scanner', status, is_dinas_luar ? 1 : 0, kegiatan_dinas || null, selfie_url, latitude || null, longitude || null]
    );

    // Send WhatsApp notification after successful attendance
    try {
      const [teacherData] = await db.query(
        'SELECT nama, no_wa, jenis_kelamin FROM teachers WHERE id = ? AND status_aktif = 1',
        [req.user.guru_id]
      );

      if (teacherData && teacherData.no_wa && teacherData.nama) {
        const waktuSekarang = new Date().toLocaleString('id-ID', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });

        const statusText = status === 'tepat_waktu' ? 'Tepat Waktu ⏰' :
                          status === 'terlambat' ? 'Terlambat ⏰' : status;

        let content = `🔔 *NOTIFIKASI ABSENSI*

Absensi Anda telah berhasil dicatat:

📅 *Waktu:* ${waktuSekarang}
📍 *Jenis:* ${jenis === 'masuk' ? 'Masuk' : 'Pulang'}
📊 *Status:* ${statusText}
📱 *Metode:* ${metode || 'Scanner'}
🏫 *Unit:* ${tenant_id}`;

        if (is_dinas_luar) {
          content += `
🚗 *Dinas Luar:* Ya
📝 *Kegiatan:* ${kegiatan_dinas || 'Tidak disebutkan'}`;
        }

        content += `

Terima kasih telah melakukan absensi tepat waktu!`;

        const message = formatIslamicMessage(teacherData.nama, teacherData.jenis_kelamin, content);

        // Send WhatsApp notification (don't wait for response)
sendWhatsAppMessage(teacherData.no_wa, message).catch(err =>
          console.log('[WHATSAPP ATTENDANCE ERROR]', err.message)
        );
      }
    } catch (error) {
      console.error('[WHATSAPP NOTIFICATION ERROR]', error.message);
    }
  } catch (error) {
    console.error('[ATTENDANCE ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error recording attendance' });
  }
});

// Admin tenants list
app.get('/api/admin/tenants', authenticateOperator, async (req, res) => {
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
app.get('/api/admin/summary', authenticateOperator, async (req, res) => {
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

// Admin attendance logs
app.get('/api/admin/attendance-logs', authenticateOperator, async (req, res) => {
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
JOIN teacher_assignments ta ON t.id = ta.teacher_id AND ta.tenant_id = ?
        WHERE 1=1
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
      res.status(500).json({ success: false, message: 'Error fetching attendance logs' });
    }
  });

  // ====================  MONTHLY ATTENDANCE REPORT (PDF)  ====================
/**
 * Generate a landscape PDF with daily attendance columns (1-31) for a month.
 * Query parameters:
 *   tenant_id   – school tenant (required)
 *   month       – 1-12 (optional, defaults to current month)
 *   year        – four-digit year (optional, defaults to current year)
 */
app.get('/api/admin/monthly-report/pdf', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, month, year } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }

    const m = parseInt(month, 10) || new Date().getMonth() + 1;
    const y = parseInt(year, 10) || new Date().getFullYear();

    // Get last day of month
    const lastDay = new Date(y, m, 0).getDate();

    // Get tenant name
    const tenantRows = await db.query('SELECT nama_sekolah FROM tenants WHERE tenant_id = ?', [tenant_id]);
    const tenantName = tenantRows[0]?.nama_sekolah || tenant_id;

    // Fetch attendance logs for the month with daily data
    const logs = await db.query(
      `SELECT
        t.id as teacher_id,
        t.nama as teacher_name,
        a.jenis,
        DATE(a.waktu_scan) as tanggal,
        TIME(a.waktu_scan) as jam
      FROM teachers t
      JOIN teacher_assignments ta ON t.id = ta.teacher_id
      LEFT JOIN attendance_logs a ON t.id = a.teacher_id
        AND MONTH(a.waktu_scan) = ? AND YEAR(a.waktu_scan) = ?
      WHERE ta.tenant_id = ? AND t.status_aktif = 1
      ORDER BY t.nama, tanggal, a.jenis`,
      [m, y, tenant_id]
    );

    // Organize data per teacher per date (include all active teachers)
    const teacherData = {};
    logs.forEach(row => {
      // Add teacher if not exists (for teachers with no attendance)
      if (!teacherData[row.teacher_id]) {
        teacherData[row.teacher_id] = { name: row.teacher_name, dates: {} };
      }
      // Only add attendance data if exists
      if (row.jenis === 'masuk' || row.jenis === 'pulang') {
        const dateNum = parseInt(row.tanggal?.split('-')[2]) || 0;
        if (!teacherData[row.teacher_id].dates[dateNum]) {
          teacherData[row.teacher_id].dates[dateNum] = { masuk: '', pulang: '' };
        }
        if (row.jenis === 'masuk') {
          teacherData[row.teacher_id].dates[dateNum].masuk = row.jam ? row.jam.substring(0, 5) : '';
        } else {
          teacherData[row.teacher_id].dates[dateNum].pulang = row.jam ? row.jam.substring(0, 5) : '';
        }
      }
    });

    // Create PDF in Landscape
    const doc = new PDFKit({ size: 'A4', layout: 'landscape', margin: 20 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rekap_absensi_${tenant_id}_${y}_${String(m).padStart(2,'0')}.pdf"`);
    doc.pipe(res);

    // Declare pageWidth at the top (needed for header image and table calculations)
    const pageWidth = doc.page.width - 40;

    // Add header image on first page only (full width, maintain aspect ratio)
    const headerPath = path.join(__dirname, 'template', 'header-yayasan-landscape.png');
    if (fs.existsSync(headerPath)) {
      doc.image(headerPath, 20, 20, { width: pageWidth });
      doc.y = 80; // Ensure content starts below the header image
    }

    // Header text (below header image)
    doc.fontSize(16).font('Helvetica-Bold').text('REKAP ABSENSI BULANAN', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text(`Sekolah: ${tenantName} | Bulan: ${new Date(y, m - 1).toLocaleString('id-ID', { month: 'long' })} ${y}`, { align: 'center' });
    doc.moveDown(0.3);

    // Calculate dynamic column widths
    let dateColWidth = 22;
    if (lastDay > 0) {
      dateColWidth = Math.max(15, Math.floor((pageWidth - 90) / lastDay)); // Dynamic width, min 15px
    }
    const colWidths = [20, 70]; // No, Nama
    for (let i = 1; i <= lastDay; i++) {
      colWidths.push(dateColWidth);
    }

    let currentX = 20;
    let headerY = doc.y;

    // Draw table header background
    doc.rect(20, headerY, pageWidth, 25).fillColor('#047517').fill();

    // Header cells
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
    let x = 20;

    // No column
    doc.text('No', x + 2, headerY + 7, { width: 16, align: 'center' });
    x += colWidths[0];

    // Nama Guru column
    doc.text('Nama', x + 2, headerY + 7, { width: 66, align: 'center' });
    x += colWidths[1];

    // Date columns
    for (let d = 1; d <= lastDay; d++) {
      const dayNames = ['Mg', 'Sn', 'Sl', 'Ra', 'Ka', 'Ju', 'Sa'];
      const dayOfWeek = new Date(y, m - 1, d).getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      doc.text(`${d}\n${dayNames[dayOfWeek]}`, x + 1, headerY + 7, { width: dateColWidth - 2, align: 'center' });
      x += colWidths[2];
    }

    doc.font('Helvetica').fontSize(7);

    // Table rows
    let rowY = headerY + 25;
    let rowHeight = 22;
    let pageNum = 1;
    let rowIndex = 0;

    for (const [teacherId, data] of Object.entries(teacherData)) {
      // Check page overflow
      if (rowY + rowHeight > 560) {
        doc.addPage({ size: 'A4', layout: 'landscape' });
        rowY = 70; // Start below header on new page
        pageNum++;
        // Redraw header on new page
        doc.rect(20, rowY - 35, pageWidth, 25).fillColor('#047517').fill();
        doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
        x = 20;
        doc.text('No', x + 2, rowY - 28, { width: 16, align: 'center' });
        x += colWidths[0];
        doc.text('Nama', x + 2, rowY - 28, { width: 66, align: 'center' });
        x += colWidths[1];
        for (let d = 1; d <= lastDay; d++) {
          const dayNames = ['Mg', 'Sn', 'Sl', 'Ra', 'Ka', 'Ju', 'Sa'];
          const dayOfWeek = new Date(y, m - 1, d).getDay();
          doc.text(`${d}\n${dayNames[dayOfWeek]}`, x + 1, rowY - 28, { width: dateColWidth - 2, align: 'center' });
          x += colWidths[2];
        }
        doc.font('Helvetica').fontSize(7);
      }
      

      // Draw row background (alternating)
      if (rowIndex % 2 === 0) {
        doc.rect(20, rowY, pageWidth, rowHeight).fillColor('#f9fafb').fill();
      }

      // Draw cell borders and content
      x = 20;
      doc.fillColor('#000000');

      // No
      doc.text((rowIndex + 1).toString(), x + 2, rowY + 5, { width: 16, align: 'center' });
      x += colWidths[0];

      // Nama
      doc.text(data.name, x + 2, rowY + 5, { width: 66, align: 'left' });
      x += colWidths[1];

      // Date cells with conditional weekend coloring
      for (let d = 1; d <= lastDay; d++) {
        const dayOfWeek = new Date(y, m - 1, d).getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const cellData = data.dates[d] || { masuk: '', pulang: '' };

        if (isWeekend) {
          doc.rect(x, rowY, colWidths[2], rowHeight).fillColor('#fef2f2').fill();
        }

        const masukJam = cellData.masuk || '-';
        const pulangJam = cellData.pulang || '-';
        doc.fillColor('#000000').text(`${masukJam}\n${pulangJam}`, x + 1, rowY + 5, { width: dateColWidth - 2, align: 'center' });
        x += colWidths[2];
      }

      // Draw vertical borders for this row
      doc.rect(20, rowY, pageWidth, rowHeight).strokeColor('#d1d5db').lineWidth(0.3).stroke();

      rowY += rowHeight;
      rowIndex++;
    }

    doc.end();
  } catch (err) {
    console.error('[MONTHLY REPORT PDF] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

// Monthly Attendance Report HTML - for in-browser view
app.get('/api/admin/monthly-report/html', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, month, year } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }

    const m = parseInt(month, 10) || new Date().getMonth() + 1;
    const y = parseInt(year, 10) || new Date().getFullYear();
    const lastDay = new Date(y, m, 0).getDate();

    const tenantRows = await db.query('SELECT nama_sekolah FROM tenants WHERE tenant_id = ?', [tenant_id]);
    const tenantName = tenantRows[0]?.nama_sekolah || tenant_id;

    const logs = await db.query(
      `SELECT t.id as teacher_id, t.nama as teacher_name, a.jenis, DATE(a.waktu_scan) as tanggal, TIME(a.waktu_scan) as jam
       FROM teachers t
       JOIN teacher_assignments ta ON t.id = ta.teacher_id
       LEFT JOIN attendance_logs a ON t.id = a.teacher_id AND MONTH(a.waktu_scan) = ? AND YEAR(a.waktu_scan) = ?
       WHERE ta.tenant_id = ? AND t.status_aktif = 1
       ORDER BY t.nama, tanggal, a.jenis`,
      [m, y, tenant_id]
    );

    const teacherData = {};
    logs.forEach(row => {
      // Add teacher if not exists (for teachers with no attendance)
      if (!teacherData[row.teacher_id]) {
        teacherData[row.teacher_id] = { name: row.teacher_name, dates: {} };
      }
      // Only add attendance data if exists
      if (row.jenis === 'masuk' || row.jenis === 'pulang') {
        const dateNum = parseInt(row.tanggal?.split('-')[2]) || 0;
        if (!teacherData[row.teacher_id].dates[dateNum]) {
          teacherData[row.teacher_id].dates[dateNum] = { masuk: '', pulang: '' };
        }
        if (row.jenis === 'masuk') {
          teacherData[row.teacher_id].dates[dateNum].masuk = row.jam ? row.jam.substring(0, 5) : '';
        } else {
          teacherData[row.teacher_id].dates[dateNum].pulang = row.jam ? row.jam.substring(0, 5) : '';
        }
      }
    });

    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const dayNames = ['Mg', 'Sn', 'Sl', 'Ra', 'Ka', 'Ju', 'Sa'];

    let html = `<div class="overflow-x-auto">
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="bg-blue-600 text-white">
            <th class="border border-gray-300 px-2 py-1 w-10">No</th>
            <th class="border border-gray-300 px-2 py-1 w-40">Nama</th>`;
    
    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      const isWeekend = dow === 0 || dow === 6;
      html += `<th class="border border-gray-300 px-1 py-1 w-12 ${isWeekend ? 'bg-red-50' : ''}">${d}<br><span class="text-[10px]">${dayNames[dow]}</span></th>`;
    }
    
    html += `</tr></thead><tbody>`;
    
    let rowIndex = 0;
    for (const [teacherId, data] of Object.entries(teacherData)) {
      html += `<tr class="${rowIndex % 2 === 0 ? 'bg-gray-50' : 'bg-white'} hover:bg-blue-50">
        <td class="border border-gray-300 px-2 py-1 text-center">${rowIndex + 1}</td>
        <td class="border border-gray-300 px-2 py-1 font-medium">${data.name}</td>`;
      
      for (let d = 1; d <= lastDay; d++) {
        const dow = new Date(y, m - 1, d).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const cellData = data.dates[d] || { masuk: '', pulang: '' };
        html += `<td class="border border-gray-300 px-1 py-1 text-center ${isWeekend ? 'bg-red-50' : ''}"><div class="text-[10px] leading-tight">${cellData.masuk || '-'}<br>${cellData.pulang || '-'}</div></td>`;
      }
      
      html += `</tr>`;
      rowIndex++;
    }
    
    html += `</tbody></table></div>
      <div class="mt-4 text-xs text-gray-600">
        <p><strong>Keterangan:</strong> Format: Jam Masuk / Jam Pulang. Kolom berwarna merah adalah akhir pekan.</p>
      </div>`;

    res.send(html);
  } catch (err) {
    console.error('[MONTHLY REPORT HTML] Error:', err);
    res.status(500).send('<p class="text-red-500">Gagal memuat rekap bulanan</p>');
  }
});

// Admin teachers list with pagination
app.get('/api/admin/teachers', authenticateOperator, async (req, res) => {
  try {
const page = parseInt(req.query.page) || 1;
     const limit = parseInt(req.query.limit) || 10;
     const offset = (page - 1) * limit;
     const search = req.query.search ? req.query.search.trim() : '';
     const getAll = req.query.all === '1';
     const hasWa = req.query.has_wa === '1';
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
        return res.status(400).json({ success: false, message: 'Anda memiliki lebih dari satu penugasan. Silakan tentukan tenant_id.' });
      }
    }

    // Verify tenant access
    if (tenantId && !verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data guru sekolah ini' });
    }

    let whereClause = 't.status_aktif = 1';
    let queryParams = [];

    if (search) {
      whereClause += ' AND t.nama LIKE ?';
      queryParams.push('%' + search + '%');
    }

    if (hasWa) {
      whereClause += ' AND t.no_wa IS NOT NULL AND t.no_wa != ""';
    }

    if (tenantId) {
      whereClause += ' AND EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id = t.id AND ta.tenant_id = ?)';
      queryParams.push(tenantId);
    }

    const [totalResult] = await db.query('SELECT COUNT(*) as count FROM teachers t WHERE ' + whereClause, queryParams);
    const total = totalResult.count;

    let query = `
      SELECT
        t.id, t.nama, t.nik, t.nip, t.email, t.status_kepegawaian, t.status_aktif, t.no_wa,
        GROUP_CONCAT(DISTINCT CONCAT(ta.tenant_id, ':', ta.jabatan_di_unit, ':', tn.nama_sekolah)) as assignments
      FROM teachers t
      LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
      LEFT JOIN tenants tn ON ta.tenant_id = tn.tenant_id
      WHERE ${whereClause}
      GROUP BY t.id
      ORDER BY t.nama ASC
    `;

    if (!getAll) {
      query += ' LIMIT ? OFFSET ?';
      queryParams.push(limit, offset);
    }

    const teachers = await db.query(query, queryParams);

    // Format assignments
    const formattedTeachers = teachers.map(teacher => ({
      ...teacher,
      assignments: teacher.assignments ? teacher.assignments.split(',').map(a => {
        const [tenant_id, jabatan, nama_sekolah] = a.split(':');
        return { tenant_id, jabatan_di_unit: jabatan, nama_sekolah };
      }) : []
    }));

    res.json({
      success: true,
      data: formattedTeachers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Admin teachers error:', error);
    res.status(500).json({ success: false, message: 'Error fetching teachers' });
  }
});

// Admin rules list
app.get('/api/admin/rules', authenticateOperator, async (req, res) => {
  try {
    var tenantId = req.query.tenant_id;
    var query = 'SELECT * FROM attendance_rules';
    var params = [];
    if (tenantId) {
      query += ' WHERE tenant_id = ?';
      params.push(tenantId);
    }
    query += ' ORDER BY tenant_id, tipe, jam_mulai';
    var rules = await db.query(query, params);
    res.json({ success: true, data: rules });
  } catch (error) {
    console.error('Admin rules error:', error);
    res.status(500).json({ success: false, message: 'Error fetching rules' });
  }
});

// Admin tenant locations list
app.get('/api/admin/tenant-locations', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
var query = 'SELECT tl.*, t.nama_sekolah FROM tenant_locations tl JOIN tenants t ON tl.tenant_id  = t.tenant_id ';
     var params = [];
     if (tenantId) {
       query += ' WHERE tl.tenant_id = ? ';
       params.push(tenantId);
     }
    query += ' ORDER BY tl.tenant_id, tl.location_name';
    var locations = await db.query(query, params);
    res.json({ success: true, data: locations });
  } catch (error) {
    console.error('TENANT LOCATIONS LIST ERROR:', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenant locations' });
  }
});

// Admin tenant locations by tenant
app.get('/api/admin/tenant-locations/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (!verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses lokasi sekolah ini' });
    }
const locations = await db.query(
       'SELECT * FROM tenant_locations WHERE tenant_id = ?  ORDER BY location_name',
       [tenantId]
     );
    res.json({ success: true, data: locations });
  } catch (error) {
    console.error('[TENANT LOCATIONS BY TENANT ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenant locations' });
  }
});

// Admin create tenant location
app.post('/api/admin/tenant-locations', authenticateOperator, async (req, res) => {
  try {
    var bodyTenantId = req.body.tenant_id;
    // Jika operator, force tenant_id dari assignment
    if (req.user.role === 'guru' && req.user.assignments) {
      var allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
      if (allowedTenants.length === 1) {
        bodyTenantId = allowedTenants[0];
      }
    }
    const tenant_id = bodyTenantId;

    // Verify tenant access for operator
    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses sekolah ini' });
    }

    const { location_name, latitude, longitude, location_radius } = req.body;

    // Validate required fields
    if (!tenant_id || !location_name) {
      return res.status(400).json({ success: false, message: 'tenant_id dan location_name wajib diisi' });
    }

    // Validate coordinates if provided
    if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
      return res.status(400).json({ success: false, message: 'Latitude harus antara -90 dan 90' });
    }
    if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
      return res.status(400).json({ success: false, message: 'Longitude harus antara -180 dan 180' });
    }

    const result = await db.query(
      'INSERT INTO tenant_locations (tenant_id, location_name, latitude, longitude, location_radius, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [tenant_id, location_name, latitude || null, longitude || null, location_radius || 100]
    );

    res.json({
      success: true,
      message: 'Lokasi tenant berhasil dibuat',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('[CREATE TENANT LOCATION ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error creating tenant location' });
  }
});

// Admin create tenant
app.post('/api/admin/tenants', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, nama_sekolah, absensi_method } = req.body;

    // Validate required fields
    if (!tenant_id || !nama_sekolah) {
      return res.status(400).json({ success: false, message: 'tenant_id dan nama_sekolah wajib diisi' });
    }

    // Validate tenant_id format (alphanumeric and underscore, max 20 chars)
    if (!/^[a-zA-Z0-9_]{1,20}$/.test(tenant_id)) {
      return res.status(400).json({ success: false, message: 'tenant_id hanya boleh huruf, angka, dan underscore, maksimal 20 karakter' });
    }

    // Check if tenant already exists
    const existing = await db.query('SELECT tenant_id FROM tenants WHERE tenant_id = ?', [tenant_id]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Tenant ID sudah digunakan' });
    }

    const result = await db.query(
      'INSERT INTO tenants (tenant_id, nama_sekolah, absensi_method) VALUES (?, ?, ?)',
      [tenant_id, nama_sekolah, absensi_method || 'personal']
    );

    res.json({
      success: true,
      message: 'Tenant berhasil ditambahkan',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('[CREATE TENANT ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error creating tenant' });
  }
});

// Admin update tenant location
app.put('/api/admin/tenant-locations/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;
    const { location_name, latitude, longitude, location_radius, is_active } = req.body;

    // Cari tenant_id lokasi untuk verifikasi akses operator
    const locRows = await db.query('SELECT tenant_id FROM tenant_locations WHERE id = ?', [id]);
    if (locRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan' });
    }
    if (!verifyTenantAccess(req, locRows[0].tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses lokasi sekolah ini' });
    }

    // Validate coordinates if provided
    if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
      return res.status(400).json({ success: false, message: 'Latitude harus antara -90 dan 90' });
    }
    if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
      return res.status(400).json({ success: false, message: 'Longitude harus antara -180 dan 180' });
    }

    let updateFields = [];
    let updateValues = [];

    if (location_name !== undefined) {
      updateFields.push('location_name = ?');
      updateValues.push(location_name);
    }
    if (latitude !== undefined) {
      updateFields.push('latitude = ?');
      updateValues.push(latitude);
    }
    if (longitude !== undefined) {
      updateFields.push('longitude = ?');
      updateValues.push(longitude);
    }
    if (location_radius !== undefined) {
      updateFields.push('location_radius = ?');
      updateValues.push(location_radius);
    }
    if (is_active !== undefined) {
      updateFields.push('is_active = ?');
      updateValues.push(is_active ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada data yang diupdate' });
    }

    updateValues.push(id);
    const query = `UPDATE tenant_locations SET ${updateFields.join(', ')} WHERE id = ?`;
    const result = await db.query(query, updateValues);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tenant tidak ditemukan' });
    }

    res.json({ success: true, message: 'Lokasi tenant berhasil diupdate' });
  } catch (error) {
    console.error('[UPDATE TENANT LOCATION ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error updating tenant location' });
  }
});

// Admin delete tenant location
app.delete('/api/admin/tenant-locations/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;

    // Cari tenant_id lokasi untuk verifikasi akses operator
    const locRows = await db.query('SELECT tenant_id FROM tenant_locations WHERE id = ?', [id]);
    if (locRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan' });
    }
    if (!verifyTenantAccess(req, locRows[0].tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses lokasi sekolah ini' });
    }

    const result = await db.query('DELETE FROM tenant_locations WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tenant tidak ditemukan' });
    }

    res.json({ success: true, message: 'Lokasi tenant berhasil dihapus' });
  } catch (error) {
    console.error('[DELETE TENANT LOCATION ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error deleting tenant location' });
  }
});





// Admin tenant detail
app.get('/api/admin/tenants/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;
// Verify operator access to this tenant
     if (req.user.role === 'guru' && req.user.assignments) {
       var allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
       if (!allowedTenants.includes(tenantId)) {
         return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data sekolah ini' });
       }
     }
     const [tenant] = await db.query('SELECT * FROM tenants WHERE tenant_id = ?', [tenantId]);

    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    res.json({ success: true, data: tenant });
  } catch (error) {
    console.error('Admin tenant detail error:', error);
    res.status(500).json({ success: false, message: 'Error fetching tenant' });
  }
});

// Admin update tenant (including location)
app.put('/api/admin/tenants/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;
// Verify operator access to this tenant
     if (req.user.role === 'guru' && req.user.assignments) {
       var allowedTenants = (req.user.assignments || []).map(a => a.tenant_id);
       if (!allowedTenants.includes(tenantId)) {
         return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengedit data sekolah ini' });
       }
     }
     const { latitude, longitude, location_radius, location_name, use_central_rules } = req.body;

    // Validate input
    if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
      return res.status(400).json({ success: false, message: 'Latitude harus antara -90 dan 90' });
    }
    if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
      return res.status(400).json({ success: false, message: 'Longitude harus antara -180 dan 180' });
    }
    if (location_radius !== undefined && (location_radius < 10 || location_radius > 1000)) {
      return res.status(400).json({ success: false, message: 'Radius lokasi harus antara 10 dan 1000 meter' });
    }

    // Update tenant basic info
    const tenantFields = [];
    const tenantValues = [];

    if (use_central_rules !== undefined) {
      tenantFields.push('use_central_rules = ?');
      tenantValues.push(use_central_rules ? 1 : 0);
    }

    // Handle location update/insert in tenant_locations
    if (latitude !== undefined || longitude !== undefined || location_radius !== undefined || location_name !== undefined) {
      // Check if active location exists for this tenant
      const existingLocations = await db.query(
        'SELECT id FROM tenant_locations WHERE tenant_id = ? AND is_active = 1',
        [tenantId]
      );

      if (existingLocations.length > 0) {
        // Update existing active location
        const locationFields = [];
        const locationValues = [];

        if (latitude !== undefined) {
          locationFields.push('latitude = ?');
          locationValues.push(latitude);
        }
        if (longitude !== undefined) {
          locationFields.push('longitude = ?');
          locationValues.push(longitude);
        }
        if (location_radius !== undefined) {
          locationFields.push('location_radius = ?');
          locationValues.push(location_radius);
        }
        if (location_name !== undefined) {
          locationFields.push('location_name = ?');
          locationValues.push(location_name);
        }

        locationValues.push(existingLocations[0].id);
        await db.query(
          `UPDATE tenant_locations SET ${locationFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
          locationValues
        );
      } else {
        // Insert new active location
        await db.query(
          `INSERT INTO tenant_locations (tenant_id, location_name, latitude, longitude, location_radius, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
          [
            tenantId,
            location_name || 'Lokasi Utama',
            latitude || null,
            longitude || null,
            location_radius || 100
          ]
        );
      }
    }

    // Update tenant table if there are fields to update
    if (tenantFields.length > 0) {
      tenantValues.push(tenantId);
      await db.query(
        `UPDATE tenants SET ${tenantFields.join(', ')}, updated_at = NOW() WHERE tenant_id = ?`,
        tenantValues
      );
    }

    res.json({ success: true, message: 'Data sekolah berhasil diperbarui' });
  } catch (error) {
    console.error('Admin update tenant error:', error);
    res.status(500).json({ success: false, message: 'Error updating tenant' });
  }
});

// Admin create rule
app.post('/api/admin/rules', authenticateOperator, async (req, res) => {
  try {
    const { tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari } = req.body;

    // Validate required fields
    if (!tenant_id || !tipe || !jam_mulai || !jam_selesai || !status_log) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang membuat aturan untuk sekolah ini' });
    }

    // Validate tipe and status_log
    if (!['Datang', 'Pulang'].includes(tipe)) {
      return res.status(400).json({ success: false, message: 'Tipe harus Datang atau Pulang' });
    }
    if (!['tepat_waktu', 'terlambat'].includes(status_log)) {
      return res.status(400).json({ success: false, message: 'Status log harus tepat_waktu atau terlambat' });
    }

    // Validate time format
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(jam_mulai) || !timeRegex.test(jam_selesai)) {
      return res.status(400).json({ success: false, message: 'Format jam harus HH:MM' });
    }

    // Insert rule
    const result = await db.query(
      'INSERT INTO attendance_rules (tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenant_id, tipe, jam_mulai, jam_selesai, keterangan || null, status_log, hari || null]
    );

    res.json({
      success: true,
      message: 'Aturan absensi berhasil dibuat',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Admin create rule error:', error);
    res.status(500).json({ success: false, message: 'Error creating rule' });
  }
});

// Admin update rule
app.put('/api/admin/rules/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, tipe, jam_mulai, jam_selesai, keterangan, status_log, hari } = req.body;

    // Validate required fields
    if (!tenant_id || !tipe || !jam_mulai || !jam_selesai || !status_log) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengedit aturan sekolah ini' });
    }

    // Validate tipe and status_log
    if (!['Datang', 'Pulang'].includes(tipe)) {
      return res.status(400).json({ success: false, message: 'Tipe harus Datang atau Pulang' });
    }
    if (!['tepat_waktu', 'terlambat'].includes(status_log)) {
      return res.status(400).json({ success: false, message: 'Status log harus tepat_waktu atau terlambat' });
    }

    // Validate time format
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(jam_mulai) || !timeRegex.test(jam_selesai)) {
      return res.status(400).json({ success: false, message: 'Format jam harus HH:MM' });
    }

    // Update rule
    const result = await db.query(
      'UPDATE attendance_rules SET tenant_id = ?, tipe = ?, jam_mulai = ?, jam_selesai = ?, keterangan = ?, status_log = ?, hari = ?, updated_at = NOW() WHERE id = ?',
      [tenant_id, tipe, jam_mulai, jam_selesai, keterangan || null, status_log, hari || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Rule tidak ditemukan' });
    }

    res.json({ success: true, message: 'Aturan absensi berhasil diupdate' });
  } catch (error) {
    console.error('Admin update rule error:', error);
    res.status(500).json({ success: false, message: 'Error updating rule' });
  }
});

// Admin delete rule
app.delete('/api/admin/rules/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;

    // Cari rule untuk verifikasi tenant
    const [rule] = await db.query('SELECT tenant_id FROM attendance_rules WHERE id = ?', [id]);
    if (!rule) {
      return res.status(404).json({ success: false, message: 'Rule tidak ditemukan' });
    }
    if (!verifyTenantAccess(req, rule.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang menghapus aturan sekolah ini' });
    }

    const result = await db.query('DELETE FROM attendance_rules WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Rule tidak ditemukan' });
    }

    res.json({ success: true, message: 'Aturan absensi berhasil dihapus' });
  } catch (error) {
    console.error('Admin delete rule error:', error);
    res.status(500).json({ success: false, message: 'Error deleting rule' });
  }
});

// Admin rule detail
app.get('/api/admin/rules/:id', authenticateOperator, async (req, res) => {
   try {
     const { id } = req.params;
     const [rule] = await db.query('SELECT * FROM attendance_rules WHERE id = ?', [id]);

     if (!rule) {
       return res.status(404).json({ success: false, message: 'Rule not found' });
     }

     if (!verifyTenantAccess(req, rule.tenant_id)) {
       return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses aturan sekolah ini' });
     }

     res.json({ success: true, data: rule });
   } catch (error) {
     console.error('Admin rule detail error:', error);
     res.status(500).json({ success: false, message: 'Error fetching rule' });
   }
 });

// Admin create user for teacher
app.post('/api/admin/teachers/:teacherId/create-user', authenticateOperator, async (req, res) => {
  try {
    const { teacherId } = req.params;

    // Check if teacher exists and get email
    const [teacher] = await db.query('SELECT email, nama, tenant_id FROM teachers WHERE id = ? AND status_aktif = 1', [teacherId]);
    if (!teacher || !teacher.email) {
      return res.status(400).json({ success: false, message: 'Teacher not found or no email' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, teacher.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang membuat user untuk guru di sekolah ini' });
    }

    // Check if user already exists
    const existingUser = await db.query('SELECT id FROM users WHERE username = ?', [teacher.email]);
    if (existingUser.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    // Get tenant assignment
    const [assignment] = await db.query('SELECT tenant_id FROM teacher_assignments WHERE teacher_id = ? LIMIT 1', [teacherId]);
    const tenantId = assignment ? assignment.tenant_id : 'YPWI';

    // Create user account
    const hashedPassword = await bcrypt.hash('ypwi123', 10);
    await db.query(
      'INSERT INTO users (username, password, role, guru_id, tenant_id, is_profile_complete, is_default_password) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [teacher.email, hashedPassword, 'guru', teacherId, tenantId, 1, 1]
    );

    res.json({ success: true, message: 'User account created successfully' });
  } catch (error) {
    console.error('Admin create user error:', error);
    res.status(500).json({ success: false, message: 'Error creating user account' });
  }
});

// Admin send WhatsApp bulk
app.post('/api/admin/send-whatsapp-bulk/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { message } = req.body;

    // Verify tenant access
    if (!verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengirim pesan untuk sekolah ini' });
    }

    // Get all active teachers in tenant with WhatsApp numbers
    const teachers = await db.query(`
      SELECT t.id, t.nama, t.no_wa, t.jenis_kelamin
      FROM teachers t
      JOIN teacher_assignments ta ON t.id = ta.teacher_id
      WHERE ta.tenant_id = ? AND t.status_aktif = 1 AND t.no_wa IS NOT NULL AND t.no_wa != ''
    `, [tenantId]);

    let successCount = 0;
    let failCount = 0;

    for (const teacher of teachers) {
      try {
        const finalMessage = formatIslamicMessage(teacher.nama, teacher.jenis_kelamin, message);
        const result = await sendWhatsAppMessage(teacher.no_wa, finalMessage);
        if (result.success) successCount++;
        else failCount++;
      } catch (error) {
        console.error(`Failed to send to ${teacher.nama}:`, error);
        failCount++;
      }
    }

    res.json({
      success: true,
      message: `WhatsApp sent: ${successCount} success, ${failCount} failed`,
      data: { successCount, failCount }
    });
  } catch (error) {
    console.error('Admin bulk WhatsApp error:', error);
    res.status(500).json({ success: false, message: 'Error sending bulk WhatsApp' });
  }
});

// Admin send WhatsApp single
app.post('/api/admin/send-whatsapp-single/:teacherId', authenticateOperator, async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { message } = req.body;

    const [teacher] = await db.query('SELECT nama, no_wa, jenis_kelamin, tenant_id FROM teachers WHERE id = ? AND status_aktif = 1', [teacherId]);
    if (!teacher || !teacher.no_wa) {
      return res.status(400).json({ success: false, message: 'Teacher not found or no WhatsApp number' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, teacher.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengirim pesan ke guru ini' });
    }

    const finalMessage = formatIslamicMessage(teacher.nama, teacher.jenis_kelamin, message);
    const result = await sendWhatsAppMessage(teacher.no_wa, finalMessage);

    res.json({
      success: result.success,
      message: result.message
    });
  } catch (error) {
    console.error('Admin single WhatsApp error:', error);
    res.status(500).json({ success: false, message: 'Error sending WhatsApp' });
  }
});

// Teacher management routes
app.get('/api/admin/teachers/:id', authenticateOperator, async (req, res) => {
  const { id } = req.params;
  try {
    const teacherRows = await db.query('SELECT id, nama, nik, tempat_lahir, tanggal_lahir, jenis_kelamin, alamat, no_wa, email, status_kepegawaian, tmt, nip, scan_id, link_foto, status_aktif FROM teachers WHERE id = ? AND status_aktif = 1', [id]);
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }
    const teacher = teacherRows[0];
    const assignmentRows = await db.query('SELECT tenant_id, jabatan_di_unit FROM teacher_assignments WHERE teacher_id = ?', [id]);
    teacher.assignments = assignmentRows;

    // Verify operator access: teacher must belong to at least one allowed tenant
    if (req.user.role !== 'admin' && req.user.assignments) {
      const adminAssignments = (req.user.assignments || []).filter(a => {
        const roles = ['tu', 'tatausaha', 'operator', 'ta', 'tata_usaha'];
        return roles.includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, '_'));
      });
      const allowedTenants = adminAssignments.map(a => a.tenant_id);
      const teacherTenantIds = assignmentRows.map(a => a.tenant_id);
      const hasAccess = teacherTenantIds.some(tid => allowedTenants.includes(tid));
      if (!hasAccess) {
        return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data guru ini' });
      }
    }

    res.json({ success: true, data: teacher });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching teacher' });
  }
});

// Admin create teacher
app.post('/api/admin/teachers', authenticateOperator, async (req, res) => {
  try {
    const { nama, nik, nip, email, tempat_lahir, tanggal_lahir, jenis_kelamin, no_wa, alamat, status_kepegawaian, status_aktif, tmt, tenant_id, assignments_json } = req.body;

    if (!nama || !nik) {
      return res.status(400).json({ success: false, message: 'Nama dan NIK wajib diisi.' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang menambahkan guru ke sekolah ini' });
    }

    if (!/^\d{16}$/.test(nik)) {
      return res.status(400).json({ success: false, message: 'NIK harus terdiri dari 16 digit angka.' });
    }

    if (email && !validator.isEmail(email)) {
      return res.status(400).json({ success: false, message: 'Format email tidak valid.' });
    }

    if (no_wa && !/^(\+62|62|0)[8-9][0-9]{7,11}$/.test(no_wa.replace(/\s+/g, ''))) {
      return res.status(400).json({ success: false, message: 'Format nomor WhatsApp tidak valid.' });
    }

    const [result] = await db.query(
      'INSERT INTO teachers (nama, nik, nip, email, tempat_lahir, tanggal_lahir, jenis_kelamin, no_wa, alamat, status_kepegawaian, status_aktif, tmt, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nama, nik, nip || null, email || null, tempat_lahir || null, tanggal_lahir || null, jenis_kelamin || null, no_wa || null, alamat || null, status_kepegawaian || null, status_aktif || 1, tmt || null, tenant_id || null]
    );

    if (assignments_json) {
      try {
        const assignments = JSON.parse(assignments_json);
        for (const a of assignments) {
          await db.query('INSERT INTO teacher_assignments (teacher_id, tenant_id, jabatan_di_unit) VALUES (?, ?, ?)', [result.insertId, a.tenant_id, a.jabatan_di_unit]);
        }
      } catch (e) {
        console.error('Error processing assignments:', e.message);
      }
    }

    res.json({ success: true, message: 'Guru berhasil ditambahkan', data: { id: result.insertId } });
  } catch (error) {
    console.error('Admin create teacher error:', error.message);
    res.status(500).json({ success: false, message: 'Error creating teacher' });
  }
});

// Admin delete teacher
app.delete('/api/admin/teachers/:id', authenticateOperator, async (req, res) => {
  try {
    const { id } = req.params;

    const [teacher] = await db.query('SELECT tenant_id FROM teachers WHERE id = ?', [id]);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }

    if (!verifyTenantAccess(req, teacher.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang menghapus guru dari sekolah ini' });
    }

    await db.query('DELETE FROM teacher_assignments WHERE teacher_id = ?', [id]);
    await db.query('DELETE FROM teachers WHERE id = ?', [id]);

    res.json({ success: true, message: 'Guru berhasil dihapus' });
  } catch (error) {
    console.error('Admin delete teacher error:', error.message);
    res.status(500).json({ success: false, message: 'Error deleting teacher' });
  }
});

app.put('/api/admin/teachers/:id', authenticateOperator, teacherUpload.single('foto'), async (req, res) => {
  const { id } = req.params;

  // Get data from both body and file
  const {
    nama, nik, nip: nip_val, email, tempat_lahir, tanggal_lahir,
    jenis_kelamin, no_wa, alamat, status_kepegawaian, status_aktif,
    tmt, link_foto, assignments_json
  } = req.body;

  if (!nama || !nik) {
    return res.status(400).json({ success: false, message: 'Nama dan NIK wajib diisi.' });
  }

  // Validate NIK (16 digits for Indonesian ID)
  if (!/^\d{16}$/.test(nik)) {
    return res.status(400).json({ success: false, message: 'NIK harus terdiri dari 16 digit angka.' });
  }

  // Validate email format
  if (email && !validator.isEmail(email)) {
    return res.status(400).json({ success: false, message: 'Format email tidak valid.' });
  }

  // Validate Indonesian phone number format
  if (no_wa && !/^(\+62|62|0)[8-9][0-9]{7,11}$/.test(no_wa.replace(/\s+/g, ''))) {
    return res.status(400).json({ success: false, message: 'Format nomor WhatsApp tidak valid. Gunakan format Indonesia (08xxxxxxxxx).' });
  }

  try {
    let photoPath = null; // Don't update photo path by default
    let shouldUpdatePhoto = false;

    // If a new file was uploaded, use its path and delete old file
    if (req.file) {
      photoPath = `/uploads/${req.file.filename}`;
      shouldUpdatePhoto = true;

      // Get current photo from database to delete old file
      const [currentTeacher] = await db.query('SELECT link_foto FROM teachers WHERE id = ?', [id]);
      if (currentTeacher && currentTeacher.link_foto && currentTeacher.link_foto.startsWith('/uploads/')) {
        const oldFilePath = path.join(__dirname, 'public', currentTeacher.link_foto);
        try {
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
            console.log(`[FILE CLEANUP] Deleted old photo: ${oldFilePath}`);
          }
        } catch (fileError) {
          console.error('[FILE CLEANUP ERROR] Could not delete old photo:', fileError.message);
          // Continue with update even if file deletion fails
        }
      }
    }

    // Update teacher basic info
    let updateQuery = `UPDATE teachers SET
      nama = ?, nik = ?, nip = ?, email = ?, tempat_lahir = ?, tanggal_lahir = ?,
      jenis_kelamin = ?, no_wa = ?, alamat = ?, status_kepegawaian = ?,
      status_aktif = ?, tmt = ?, updated_at = NOW()`;
    let updateParams = [nama, nik, nip_val, email, tempat_lahir, tanggal_lahir,
      jenis_kelamin, no_wa, alamat, status_kepegawaian,
      status_aktif, tmt];

    // Only update link_foto if a new photo was uploaded
    if (shouldUpdatePhoto) {
      updateQuery += `, link_foto = ?`;
      updateParams.push(photoPath);
    }

    updateQuery += ` WHERE id = ?`;
    updateParams.push(id);

    await db.query(updateQuery, updateParams);

    // Handle assignments if provided
    if (assignments_json) {
      try {
        const assignments = JSON.parse(assignments_json);
        // Clear existing assignments
        await db.query('DELETE FROM teacher_assignments WHERE teacher_id = ?', [id]);
        // Insert new assignments
        for (const assignment of assignments) {
          await db.query(
            'INSERT INTO teacher_assignments (teacher_id, tenant_id, jabatan_di_unit) VALUES (?, ?, ?)',
            [id, assignment.tenant_id, assignment.jabatan_di_unit]
          );
        }
      } catch (assignmentError) {
        console.error('Error processing assignments:', assignmentError);
        // Continue with teacher update even if assignments fail
      }
    }

    // Auto-create user account if not exists and teacher has email
    try {
      if (email && email.trim()) {
        const existingUser = await db.query('SELECT id FROM users WHERE username = ?', [email.trim()]);

        if (existingUser.length === 0) {
          // Get tenant_id from assignments
          const assignmentRows = await db.query('SELECT tenant_id FROM teacher_assignments WHERE teacher_id = ? LIMIT 1', [id]);
          const tenantId = assignmentRows.length > 0 ? assignmentRows[0].tenant_id : 'YPWI';

          // Create user account with default password
          const hashedPassword = await bcrypt.hash('ypwi123', 10);

          await db.query(
            'INSERT INTO users (username, password, role, guru_id, tenant_id, is_profile_complete, is_default_password) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [email.trim(), hashedPassword, 'guru', id, tenantId, 1, 1] // is_profile_complete = 1, is_default_password = 1
          );

          console.log(`[AUTO-CREATE USER] Created user account for teacher ${nama} (${email})`);
        }
      }
    } catch (userError) {
      console.error('[AUTO-CREATE USER ERROR] Could not create user account:', userError.message);
      // Continue with response even if user creation fails
    }

    res.json({ success: true, message: 'Profil guru berhasil diperbarui' });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error updating teacher profile' });
  }
});

// Teacher info endpoint (for dashboard)
app.get('/api/teacher/info', authenticateToken, async (req, res) => {
  try {
    const teacherRows = await db.query(
      'SELECT id, nama, nik, no_wa, jenis_kelamin, status_aktif, link_foto FROM teachers WHERE id = ? AND status_aktif = 1',
      [req.user.guru_id]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }
    const teacher = teacherRows[0];
    const assignmentRows = await db.query(
      'SELECT ta.tenant_id, ta.jabatan_di_unit, n.nama_sekolah FROM teacher_assignments ta JOIN tenants n ON ta.tenant_id = n.tenant_id WHERE ta.teacher_id = ?',
      [req.user.guru_id]
    );
    res.json({
      success: true,
      teacher: teacher,
      assignments: assignmentRows
    });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching teacher info' });
  }
});

// Upload profile photo endpoint
app.post('/api/upload-profile-photo', authenticateToken, teacherUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const photoPath = `/uploads/${req.file.filename}`;

    // Update teacher's link_foto in database
    await db.query('UPDATE teachers SET link_foto = ?, updated_at = NOW() WHERE id = ?',
      [photoPath, req.user.guru_id]);

    res.json({
      success: true,
      message: 'Photo uploaded successfully',
      photoUrl: photoPath
    });

  } catch (error) {
    console.error('[UPLOAD ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error uploading photo' });
  }
});

// Haversine distance calculation function
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  return distance;
}

// Unit location detection endpoint
app.get('/api/units/all', authenticateToken, async (req, res) => {
  try {
    const units = await db.query(
      'SELECT tenant_id, nama_sekolah, latitude, longitude, location_radius FROM tenants WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );

    res.json({
      success: true,
      units: units
    });
  } catch (error) {
    console.error('Error fetching all units:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch units' });
  }
});

app.get('/api/units/nearby', authenticateToken, async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required' });
    }

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    // Get ALL units with coordinates to find the nearest one
    const allUnits = await db.query(
      'SELECT tenant_id, nama_sekolah, latitude, longitude FROM tenants WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );

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

// Public route for tenants (used in complete-profile)
app.get('/api/tenants', async (req, res) => {
  try {
    const rows = await db.query('SELECT tenant_id, nama_sekolah FROM tenants ORDER BY nama_sekolah ASC');
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching tenants' });
  }
});

// Get tenant by ID
app.get('/api/tenants/:id', authenticateToken, async (req, res) => {
  try {
    const [tenant] = await db.query('SELECT * FROM tenants WHERE tenant_id = ?', [req.params.id]);
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

// Get attendance history for teacher
app.get('/api/attendance-history', authenticateToken, async (req, res) => {
  try {
    const attendance = await db.query(
      'SELECT jenis, waktu_scan, status FROM attendance_logs WHERE teacher_id = ? ORDER BY waktu_scan DESC LIMIT 10',
      [req.user.guru_id]
    );
    res.json({ success: true, data: attendance });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error fetching attendance history' });
  }
});

// Public routes for teacher profile completion (no authentication required)
app.post('/api/teachers/:id/assignments', async (req, res) => {
  const { id } = req.params;
  const { tenant_id, jabatan_di_unit } = req.body;

  if (!tenant_id || !jabatan_di_unit) {
    return res.status(400).json({ success: false, message: 'Tenant ID dan Jabatan wajib diisi.' });
  }

  try {
    // Check if teacher exists
    const teacherRows = await db.query('SELECT id FROM teachers WHERE id = ? AND status_aktif = 1', [id]);
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }

    // Check if tenant exists
    const tenantRows = await db.query('SELECT tenant_id FROM tenants WHERE tenant_id = ?', [tenant_id]);
    if (tenantRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Unit sekolah tidak ditemukan' });
    }

    // Check if assignment already exists
    const existingAssignment = await db.query('SELECT id FROM teacher_assignments WHERE teacher_id = ? AND tenant_id = ? AND jabatan_di_unit = ?', [id, tenant_id, jabatan_di_unit]);
    if (existingAssignment.length > 0) {
      return res.status(400).json({ success: false, message: 'Penugasan ini sudah ada untuk guru ini' });
    }

    await db.query(
      'INSERT INTO teacher_assignments (teacher_id, tenant_id, jabatan_di_unit) VALUES (?, ?, ?)',
      [id, tenant_id, jabatan_di_unit]
    );
    res.json({ success: true, message: 'Penugasan berhasil ditambahkan' });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error adding assignment' });
  }
});

app.delete('/api/teachers/:id/assignments', async (req, res) => {
  const { id } = req.params;
  const { tenant_id, jabatan_di_unit } = req.body;

  if (!tenant_id || !jabatan_di_unit) {
    return res.status(400).json({ success: false, message: 'Tenant ID dan Jabatan wajib diisi.' });
  }

  try {
    // Check if teacher exists
    const teacherRows = await db.query('SELECT id FROM teachers WHERE id = ? AND status_aktif = 1', [id]);
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }

    const result = await db.query(
      'DELETE FROM teacher_assignments WHERE teacher_id = ? AND tenant_id = ? AND jabatan_di_unit = ?',
      [id, tenant_id, jabatan_di_unit]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Penugasan tidak ditemukan' });
    }

    res.json({ success: true, message: 'Penugasan berhasil dihapus' });
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Error deleting assignment' });
  }
});

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Forgot password endpoints
app.post('/api/forgot-password/send-otp', async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp wajib diisi' });
    }

    // Clean phone number
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('62')) {
      if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
      } else {
        cleanNumber = '62' + cleanNumber;
      }
    }

    // Check if teacher exists with this phone number
    const [teacher] = await db.query('SELECT id, nama FROM teachers WHERE no_wa = ? AND status_aktif = 1', [cleanNumber]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Nomor WhatsApp tidak terdaftar' });
    }

    // Generate 6-digit OTP
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP temporarily (in production, use Redis or database)
    global.tempOtps = global.tempOtps || {};
    global.tempOtps[cleanNumber] = {
      code: verificationCode,
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      teacherId: teacher.id
    };

    // Send WhatsApp message
    const message = `🔐 *KODE VERIFIKASI - LUPA PASSWORD*

Assalamu'alaikum ${teacher.nama}

Kode verifikasi untuk reset password Anda: *${verificationCode}*

Kode ini berlaku selama 5 menit.

Jika Anda tidak meminta reset password, abaikan pesan ini.

*YPWI Lutim*`;

    const whatsappResult = await sendWhatsAppMessage(cleanNumber, message);

    if (whatsappResult.success) {
      res.json({
        success: true,
        message: 'Kode verifikasi telah dikirim ke WhatsApp Anda',
        verificationCode: verificationCode // Remove in production
      });
    } else {
      res.status(500).json({ success: false, message: 'Gagal mengirim kode verifikasi' });
    }

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
  }
});

app.post('/api/forgot-password/reset', async (req, res) => {
  try {
    const { phoneNumber, otpCode, newPassword } = req.body;

    if (!phoneNumber || !otpCode || !newPassword) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 8 karakter' });
    }

    // Clean phone number
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('62')) {
      if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
      } else {
        cleanNumber = '62' + cleanNumber;
      }
    }

    // Verify OTP
    const tempOtp = global.tempOtps?.[cleanNumber];
    if (!tempOtp || tempOtp.code !== otpCode || Date.now() > tempOtp.expires) {
      return res.status(400).json({ success: false, message: 'Kode verifikasi tidak valid atau sudah kadaluarsa' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password in users table
    const updateResult = await db.query(
      'UPDATE users SET password = ?, is_default_password = 0 WHERE guru_id = ?',
      [hashedPassword, tempOtp.teacherId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    // Clear OTP
    delete global.tempOtps[cleanNumber];

    res.json({
      success: true,
      message: 'Password berhasil direset'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
  }
});



// Get teacher list by tenant with completion status
app.get('/api/admin/tenant-teachers/:tenantId', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Verify tenant access
    if (!verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengakses data guru sekolah ini' });
    }

    // Get teachers for this tenant with their completion status
    const teachers = await db.query(`
      SELECT
        t.id,
        t.nama,
        t.email,
        t.no_wa,
        t.jenis_kelamin,
        t.status_aktif,
        COALESCE(u.is_profile_complete, 0) as is_profile_complete,
        COALESCE(u.is_default_password, 1) as is_default_password,
        CASE
          WHEN u.is_profile_complete = 1 THEN 100
          WHEN u.id IS NOT NULL THEN 50  -- Has account but profile not complete
          ELSE 0  -- No account
        END as persentase_kelengkapan
      FROM teacher_assignments ta
      JOIN teachers t ON ta.teacher_id = t.id
      LEFT JOIN users u ON t.id = u.guru_id
      WHERE ta.tenant_id = ?
      ORDER BY persentase_kelengkapan ASC, t.nama ASC
    `, [tenantId]);

    res.json({
      success: true,
      data: teachers
    });
  } catch (error) {
    console.error('Tenant teachers error:', error);
    res.status(500).json({ success: false, message: 'Error fetching tenant teachers' });
  }
});

// Send WhatsApp reminder for incomplete profiles (bulk)
app.post('/api/admin/send-reminder-bulk', authenticateOperator, async (req, res) => {
  try {
    const { tenantId } = req.body;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant ID required' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, tenantId)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengirim pengingat untuk sekolah ini' });
    }

    // Get teachers with incomplete profiles
    const teachers = await db.query(`
      SELECT
        t.id,
        t.nama,
        t.no_wa,
        t.jenis_kelamin
      FROM teacher_assignments ta
      JOIN teachers t ON ta.teacher_id = t.id
      LEFT JOIN users u ON t.id = u.guru_id
      WHERE ta.tenant_id = ?
        AND (u.is_profile_complete IS NULL OR u.is_profile_complete = 0)
        AND t.no_wa IS NOT NULL
        AND t.status_aktif = 1
    `, [tenantId]);

    if (teachers.length === 0) {
      return res.status(404).json({ success: false, message: 'Tidak ada guru dengan profil belum lengkap' });
    }

    let successCount = 0;
    let failCount = 0;

    for (const teacher of teachers) {
      try {
        const message = `🔄 *PENGINGAT LENGKAPI PROFIL*

Assalamu'alaikum ${teacher.nama}

Profil Anda di Sistem YPWI Lutim belum lengkap. Silakan lengkapi data pribadi Anda untuk mengakses sistem absensi.

Cara melengkapi:
1. Login ke sistem dengan username: ${teacher.nama.split(' ')[0].toLowerCase()}
2. Ikuti langkah-langkah pengisian profil
3. Pastikan semua data terisi dengan benar

*YPWI Lutim*`;

        const result = await sendWhatsAppMessage(teacher.no_wa, message);
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        console.error(`Failed to send reminder to ${teacher.nama}:`, error);
        failCount++;
      }
    }

    res.json({
      success: true,
      message: `Pengiriman selesai. Berhasil: ${successCount}, Gagal: ${failCount}`,
      data: {
        total: teachers.length,
        success: successCount,
        failed: failCount
      }
    });

  } catch (error) {
    console.error('Send bulk reminder error:', error);
    res.status(500).json({ success: false, message: 'Error sending bulk reminders' });
  }
});

// Send WhatsApp reminder for incomplete profile (individual)
app.post('/api/admin/send-reminder-individual', authenticateOperator, async (req, res) => {
  try {
    const { teacherId } = req.body;

    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'Teacher ID required' });
    }

    // Get teacher data + tenant_id
    const [teacher] = await db.query(`
      SELECT
        t.id, t.nama, t.no_wa, t.jenis_kelamin, t.tenant_id,
        u.is_profile_complete
      FROM teachers t
      LEFT JOIN users u ON t.id = u.guru_id
      WHERE t.id = ?
    `, [teacherId]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
    }

    // Verify tenant access
    if (!verifyTenantAccess(req, teacher.tenant_id)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Anda tidak berwenang mengirim pengingat untuk guru di sekolah ini' });
    }

    if (!teacher.no_wa) {
      return res.status(400).json({ success: false, message: 'Guru tidak memiliki nomor WhatsApp' });
    }

    if (teacher.is_profile_complete === 1) {
      return res.status(400).json({ success: false, message: 'Profil guru sudah lengkap' });
    }

    const message = `🔄 *PENGINGAT LENGKAPI PROFIL*

Assalamu'alaikum ${teacher.nama}

Profil Anda di Sistem YPWI Lutim belum lengkap. Silakan lengkapi data pribadi Anda untuk mengakses sistem absensi.

Cara melengkapi:
1. Login ke sistem dengan username: ${teacher.nama.split(' ')[0].toLowerCase()}
2. Ikuti langkah-langkah pengisian profil
3. Pastikan semua data terisi dengan benar

*YPWI Lutim*`;

    const result = await sendWhatsAppMessage(teacher.no_wa, message);

    if (result.success) {
      res.json({
        success: true,
        message: 'Pesan pengingat berhasil dikirim'
      });
    } else {
      res.status(500).json({ success: false, message: 'Gagal mengirim pesan pengingat' });
    }

  } catch (error) {
    console.error('Send individual reminder error:', error);
    res.status(500).json({ success: false, message: 'Error sending individual reminder' });
  }
});

async function startServer() {
  console.log('Starting server...');
  try {
    await db.initializeDatabase();
    console.log('Database initialized, starting server');

    // Admin teacher completion progress
  app.get('/api/admin/teacher-completion-progress', authenticateOperator, async (req, res) => {
    try {
      console.log('Teacher completion progress endpoint called');

      // Simple query first to test database
      const simpleCount = await db.query('SELECT COUNT(*) as count FROM teachers WHERE status_aktif = 1');
      console.log('Total active teachers:', simpleCount[0].count);

      // Get basic teacher data first
      const basicTeachers = await db.query('SELECT id, nama FROM teachers WHERE status_aktif = 1 ORDER BY nama ASC LIMIT 5');
      console.log('Sample teachers:', basicTeachers);

      // Get all active teachers with their completion data
      const teachers = await db.query(`
        SELECT
          t.id,
          t.nama,
          t.nik,
          t.nip,
          t.email,
          t.tempat_lahir,
          t.tanggal_lahir,
          t.jenis_kelamin,
          t.alamat,
          t.no_wa,
          t.status_kepegawaian,
          t.tmt,
          COUNT(ta.teacher_id) as assignment_count,
          GROUP_CONCAT(DISTINCT ta.jabatan_di_unit) as jabatan_list,
          GROUP_CONCAT(DISTINCT tn.nama_sekolah) as sekolah_list
        FROM teachers t
        LEFT JOIN teacher_assignments ta ON t.id = ta.teacher_id
        LEFT JOIN tenants tn ON ta.tenant_id = tn.tenant_id
        WHERE t.status_aktif = 1
        GROUP BY t.id
        ORDER BY t.nama ASC
      `);

      console.log('Teacher completion progress query result:', teachers.length, 'teachers found');

      // Calculate completion percentage for each teacher
      const completionData = teachers.map(teacher => {
        // Define fields to check (excluding system fields and NIY if exists)
        const fieldsToCheck = [
          'nama', 'nik', 'nip', 'email', 'tempat_lahir', 'tanggal_lahir',
          'jenis_kelamin', 'alamat', 'no_wa', 'status_kepegawaian', 'tmt'
        ];

        let filledFields = 0;
        let totalFields = fieldsToCheck.length;

        // Check each field
        fieldsToCheck.forEach(field => {
          if (teacher[field] && teacher[field].toString().trim() !== '') {
            filledFields++;
          }
        });

        // Bonus for having assignments (minimum 1)
        const hasAssignments = teacher.assignment_count > 0;
        if (hasAssignments) {
          filledFields += 1; // Bonus point for assignments
          totalFields += 1;
        }

        // Calculate percentage
        const percentage = Math.round((filledFields / totalFields) * 100);

        return {
          id: teacher.id,
          nama: teacher.nama,
          nik: teacher.nik,
          nip: teacher.nip,
          email: teacher.email,
          filled_fields: filledFields,
          total_fields: totalFields,
          has_assignments: hasAssignments,
          assignment_count: teacher.assignment_count,
          jabatan_list: teacher.jabatan_list,
          sekolah_list: teacher.sekolah_list,
          completion_percentage: percentage,
          status: percentage >= 100 ? 'Lengkap' :
                  percentage >= 80 ? 'Hampir Lengkap' :
                  percentage >= 50 ? 'Sedang Dilengkapi' : 'Perlu Dilengkapi'
        };
      });

      console.log('Calculated completion data sample:', completionData.slice(0, 3));

      // Calculate overall statistics
      const stats = {
        total_teachers: completionData.length,
        complete_teachers: completionData.filter(t => t.completion_percentage >= 100).length,
        average_completion: completionData.length > 0 ? Math.round(completionData.reduce((sum, t) => sum + t.completion_percentage, 0) / completionData.length) : 0,
        completion_distribution: {
          lengkap: completionData.filter(t => t.completion_percentage >= 100).length,
          hampir_lengkap: completionData.filter(t => t.completion_percentage >= 80 && t.completion_percentage < 100).length,
          sedang_dilengkapi: completionData.filter(t => t.completion_percentage >= 50 && t.completion_percentage < 80).length,
          perlu_dilengkapi: completionData.filter(t => t.completion_percentage < 50).length
        }
      };

      console.log('Completion stats:', stats);

      res.json({
        success: true,
        data: completionData,
        stats: stats
      });
    } catch (error) {
      console.error('Teacher completion progress error:', error);
      res.status(500).json({ success: false, message: 'Error fetching teacher completion progress', error: error.message });
    }
  });

  } catch (dbError) {
    console.log('Database connection failed:', dbError.message);
    console.log('Continuing without database...');
  }

  // ============================================
  // SCANNER DEVICE ATTENDANCE ENDPOINTS
  // ============================================

  // HMAC utility for QR signature validation
  const crypto = require('crypto');
  const SCANNER_SECRET_KEY = process.env.SCANNER_SECRET_KEY || 'ypwi-scanner-secret-2026';

  /**
   * Generate HMAC signature for QR code
   * @param {string} scanId - Teacher's scan_id
   * @param {string} timestamp - ISO datetime string
   * @param {string} tenantId - School/tenant ID
   * @param {string} type - 'masuk' or 'pulang'
   * @returns {string} HMAC-SHA256 signature
   */
  const generateQRSignature = (scanId, timestamp, tenantId, type) => {
    const payload = `${scanId}|${timestamp}|${tenantId}|${type}`;
    return crypto.createHmac('sha256', SCANNER_SECRET_KEY).update(payload).digest('hex');
  };

  /**
   * Verify QR signature
   * @param {string} scanId - Teacher's scan_id
   * @param {string} timestamp - ISO datetime string
   * @param {string} tenantId - School/tenant ID
   * @param {string} type - 'masuk' or 'pulang'
   * @param {string} signature - HMAC signature to verify
   * @returns {boolean} true if valid
   */
   const verifyQRSignature = (scanId, timestamp, tenantId, type, signature) => {
     try {
       const expected = generateQRSignature(scanId, timestamp, tenantId, type);
       // Accept exact legacy signature (for backward compatibility with old QR codes)
       const legacySignature = 'legacy-' + scanId;
       if (signature === legacySignature) {
         console.log(`[SCANNER] Legacy signature accepted for scan_id ${scanId}`);
         return true;
       }
       // Ensure both buffers have same length before timingSafeEqual
       const sigBuf = Buffer.from(signature);
       const expBuf = Buffer.from(expected);
       if (sigBuf.length !== expBuf.length) {
         console.log(`[SCANNER] Signature length mismatch: provided ${sigBuf.length}, expected ${expBuf.length}`);
         return false;
       }
       return crypto.timingSafeEqual(sigBuf, expBuf);
     } catch (error) {
       console.log('[SCANNER] Signature verification error:', error.message);
       return false;
     }
   };

  /**
   * POST /api/scanner/register
   * Register a new scanner device (called once during device setup)
   */
  app.post('/api/scanner/register', async (req, res) => {
    try {
      const { device_id, tenant_id, school_name, device_name } = req.body;

      if (!device_id || !tenant_id || !school_name) {
        return res.status(400).json({
          success: false,
          message: 'device_id, tenant_id, dan school_name wajib diisi'
        });
      }

      // Check if device already exists
      const existing = await db.query('SELECT id FROM scanner_devices WHERE device_id = ?', [device_id]);
      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Device sudah terdaftar'
        });
      }

      // Verify tenant exists
      const tenant = await db.query('SELECT tenant_id, nama_sekolah FROM tenants WHERE tenant_id = ?', [tenant_id]);
      if (tenant.length === 0) {
        return res.status(404).json({ success: false, message: 'Sekolah tidak ditemukan' });
      }

      // Generate unique secret key for this device
      const secret_key = crypto.randomBytes(32).toString('hex');

      // Insert device
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
          secret_key, // Send once during registration
          tenant_id,
          school_name
        }
      });
    } catch (error) {
      console.error('[SCANNER REGISTER ERROR]', error.message);
      res.status(500).json({ success: false, message: 'Error registering device' });
    }
  });

  /**
   * POST /api/scanner/attendance
   * Receive attendance scan from scanner device (online real-time)
   * OR receive queued offline scans
   */
  app.post('/api/scanner/attendance', async (req, res) => {
    try {
      const { scan_id, timestamp, type, device_id, signature, offline_validated, expiry } = req.body;

      // Validation
      if (!scan_id || !timestamp || !type || !device_id || !signature) {
        return res.status(400).json({
          success: false,
          message: 'scan_id, timestamp, type, device_id, dan signature wajib diisi'
        });
      }

      if (!['masuk', 'pulang'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Tipe harus masuk atau pulang' });
      }

      // Verify device exists and active
      const device = await db.query('SELECT * FROM scanner_devices WHERE device_id = ? AND status = ?', [device_id, 'active']);
      if (device.length === 0) {
        return res.status(403).json({ success: false, message: 'Device tidak valid atau tidak aktif' });
      }
      const deviceRecord = device[0];
      const tenant_id = deviceRecord.tenant_id;

      // Verify QR signature (use expiry if provided, otherwise timestamp)
      // If expiry is present, verify against expiry; otherwise against timestamp
      const signatureTimestamp = expiry || timestamp;
      const isValid = verifyQRSignature(scan_id, signatureTimestamp, tenant_id, type, signature);
      if (!isValid) {
        console.log(`[SCANNER] Invalid signature from device ${device_id} for scan_id ${scan_id}`);
        return res.status(403).json({ success: false, message: 'QR code tidak valid atau telah dimodifikasi' });
      }

      // Check QR expiry if expiry provided
      if (expiry && new Date() > new Date(expiry)) {
        console.log(`[SCANNER] Expired QR from device ${device_id} for scan_id ${scan_id}, expiry: ${expiry}`);
        return res.status(403).json({ success: false, message: 'QR code sudah kedaluwarsa' });
      }

      // Find teacher by scan_id
      const teacher = await db.query('SELECT id, nama, jenis_kelamin FROM teachers WHERE scan_id = ? AND status_aktif = 1', [scan_id]);
      if (teacher.length === 0) {
        return res.status(404).json({ success: false, message: 'Guru tidak ditemukan dengan scan_id tersebut' });
      }
      const teacherRecord = teacher[0];
      const teacher_id = teacherRecord.id;

      // Check if teacher is assigned to this tenant (for dinas luar detection)
      const assignments = await db.query('SELECT tenant_id FROM teacher_assignments WHERE teacher_id = ?', [teacher_id]);
      const assignedTenantIds = assignments.map(a => a.tenant_id);
      const is_dinas_luar = !assignedTenantIds.includes(tenant_id);

      // Parse timestamp (actual scan time)
      const scanTime = new Date(timestamp);
      if (isNaN(scanTime.getTime())) {
        return res.status(400).json({ success: false, message: 'Format timestamp tidak valid' });
      }

      // Check for duplicate scan (same teacher, same day, same type within 5 minutes)
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

      // Determine status (tepat_waktu / terlambat) based on time
      let status = 'terlambat'; // default

      // Check if tenant uses central rules
      let rulesTenantId = tenant_id;
      try {
        const [tenantData] = await db.query('SELECT use_central_rules FROM tenants WHERE tenant_id = ?', [tenant_id]);
        if (tenantData && tenantData.use_central_rules) {
          rulesTenantId = 'YPWILUTIM';
          console.log(`[SCANNER] Using central rules (YPWILUTIM) for tenant ${tenant_id}`);
        }
      } catch (tenantError) {
        console.log('[SCANNER] Could not check central rules setting, using tenant rules');
      }

      // Get current day for rule filtering
      const currentDay = scanTime.toLocaleDateString('id-ID', { weekday: 'long' }).toLowerCase();

      try {
        // Get all potential rules and filter by day in JavaScript
        const allRules = await db.query(
          'SELECT status_log, hari, jam_mulai FROM attendance_rules WHERE tenant_id = ? AND tipe = ? AND ? BETWEEN jam_mulai AND jam_selesai ORDER BY jam_mulai DESC',
          [rulesTenantId, type === 'masuk' ? 'Datang' : 'Pulang', scanTime.toTimeString().slice(0, 8)]
        );

        // Filter rules that match the current day
        const matchingRules = allRules.filter(rule => isDayMatch(rule.hari, currentDay));

        // Take the first matching rule (earliest jam_mulai)
        if (matchingRules.length > 0) {
          status = matchingRules[0].status_log;
        }
      } catch (ruleError) {
        console.log('[SCANNER] Could not fetch attendance rules, using default terlambat');
      }

      // Create attendance log
      const result = await db.query(
        `INSERT INTO attendance_logs
         (teacher_id, tenant_id, waktu_scan, jenis, metode, status, dinas_luar, kegiatan_dinas, selfie_url, latitude, longitude)
         VALUES (?, ?, ?, ?, 'scanner', ?, ?, ?, NULL, NULL, NULL)`,
        [teacher_id, tenant_id, scanTime, type, status, is_dinas_luar ? 1 : 0, is_dinas_luar ? 1 : null]
      );

      const attendance_id = result.insertId;

      // Log to qr_attendance_logs for audit
      await db.query(
        `INSERT INTO qr_attendance_logs 
         (scan_id, teacher_id, device_id, tenant_id, waktu_scan, jenis, signature, sync_status, offline_validated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
        [scan_id, teacher_id, device_id, tenant_id, scanTime, type, signature, offline_validated || false]
      );

      // Update device last_sync
      await db.query('UPDATE scanner_devices SET last_sync = NOW() WHERE device_id = ?', [device_id]);

      console.log(`[SCANNER] Attendance recorded: ${teacherRecord.nama} (${scan_id}) - ${type} at ${timestamp}`);

      // Send WhatsApp notification (same as normal attendance)
      try {
        const teacherData = await db.query(
          'SELECT nama, no_wa, jenis_kelamin FROM teachers WHERE id = ? AND status_aktif = 1',
          [teacher_id]
        );
        if (teacherData && teacherData[0] && teacherData[0].no_wa) {
          const waktuSekarang = scanTime.toLocaleString('id-ID', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });

          const statusText = status === 'tepat_waktu' ? 'Tepat Waktu ⏰' : 'Terlambat ⏰';

          let content = `🔔 *NOTIFIKASI ABSENSI (Scanner)*

Absensi Anda telah berhasil dicatat:

📅 *Waktu:* ${waktuSekarang}
📍 *Jenis:* ${type === 'masuk' ? 'Masuk' : 'Pulang'}
📊 *Status:* ${statusText}
🏫 *Unit:* ${tenant_id}
📱 *Metode:* Scanner Device`;

          if (offline_validated) {
            content += `
⚠️ *Catatan:* Absen direkam offline dan tersinkronisasi nanti.`;
          }

          content += `

Terima kasih telah melakukan absensi!`;

          // Format with Islamic greeting
          const panggilan = teacherData[0].jenis_kelamin === 'P' ? 'Ustadzah' : 'Ustadz';
          const salam = `Assalamu'alaikum ${panggilan} ${teacherData[0].nama}`;
          const finalMessage = `${salam}\n\n${content}\n\nBarakallahu fiikum,\n*YPWI Lutim*`;

          // Send async (don't block response)
          sendWhatsAppMessage(teacherData[0].no_wa, finalMessage).catch(err =>
            console.log('[WHATSAPP SCANNER ERROR]', err.message)
          );
        }
      } catch (waError) {
        console.log('[WHATSAPP SCANNER ERROR]', waError.message);
        // Don't fail attendance if WhatsApp fails
      }

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

/**
     * GET /api/public/tenants
     * Public endpoint for scanner device setup (no auth required)
     */
    app.get('/api/public/tenants', async (req, res) => {
      try {
        const tenants = await db.query('SELECT tenant_id, nama_sekolah FROM tenants ORDER BY nama_sekolah ASC');
        res.json({ success: true, data: tenants });
      } catch (error) {
        console.error('[PUBLIC TENANTS] Error:', error.message);
        res.status(500).json({ success: false, message: 'Error fetching tenants' });
      }
    });

    /**
     * GET /api/scanner/check-status
     * Public endpoint to check if teacher already scanned today (for masuk/pulang logic)
     */
    app.get('/api/scanner/check-status', async (req, res) => {
      const { scan_id } = req.query;
      if (!scan_id) {
        return res.status(400).json({ success: false, message: 'scan_id required' });
      }

      try {
        // Check if teacher has 'masuk' today
        const today = new Date().toISOString().split('T')[0];
        const masukCheck = await db.query(
          'SELECT id FROM attendance_logs WHERE teacher_id = (SELECT id FROM teachers WHERE scan_id = ?) AND jenis = \'masuk\' AND DATE(waktu_scan) = ?',
          [scan_id, today]
        );

        const pulangCheck = await db.query(
          'SELECT id FROM attendance_logs WHERE teacher_id = (SELECT id FROM teachers WHERE scan_id = ?) AND jenis = \'pulang\' AND DATE(waktu_scan) = ?',
          [scan_id, today]
        );

        // Get allowed pulang time from rules
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

    /**
     * GET /api/version
     * Public endpoint to get current app version
     */
    app.get('/api/version', (req, res) => {
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

    /**
     * GET /api/test-buttons
     * Test endpoint to verify button functionality
     */
    app.get('/api/test-buttons', (req, res) => {
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

    /**
     * POST /api/log-click
     * Log button clicks from scanner (for mobile debugging)
     */
    app.post('/api/log-click', (req, res) => {
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

   /**
    * GET /api/scanner/status
    * Admin endpoint to check scanner device status
    */
  app.get('/api/scanner/status', authenticateToken, async (req, res) => {
    try {
      // Only admin can access
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
   * GET /api/scanner/qr/generate
   * Admin endpoint to generate QR code data (not image)
   * Returns JSON that can be encoded to QR
   */
  app.get('/api/scanner/qr/generate', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const scan_id = req.query.scan_id;
      const expiry_hours = parseInt(req.query.expiry) || 24;

      if (!scan_id) {
        return res.status(400).json({ success: false, message: 'scan_id wajib diisi' });
      }

      // Verify teacher exists
      const teacher = await db.query(`
        SELECT t.id, t.nama, t.scan_id, ta.tenant_id, tn.nama_sekolah 
        FROM teachers t 
        JOIN teacher_assignments ta ON t.id = ta.teacher_id 
        JOIN tenants tn ON ta.tenant_id = tn.tenant_id 
        WHERE t.scan_id = ? AND t.status_aktif = 1 
        LIMIT 1
      `, [scan_id]);

      if (teacher.length === 0) {
        return res.status(404).json({ success: false, message: 'Guru tidak ditemukan' });
      }
      const teacherRecord = teacher[0];

      // Generate QR data (JSON)
      const expiryTime = new Date();
      expiryTime.setHours(expiryTime.getHours() + expiry_hours);

      const qrData = {
        scan_id: teacherRecord.scan_id,
        teacher_id: teacherRecord.id,
        nama: teacherRecord.nama,
        tenant_id: teacherRecord.tenant_id,
        nama_sekolah: teacherRecord.nama_sekolah,
        expiry: expiryTime.toISOString(),
        type: 'attendance', // can be masuk/pulang scan决定
        generated_at: new Date().toISOString()
      };

      // Sign the QR data
      const signature = generateQRSignature(
        qrData.scan_id,
        qrData.expiry,
        qrData.tenant_id,
        'attendance' // generic type, actual type determined at scan time
      );
      qrData.signature = signature;

      console.log(`[QR GENERATE] Generated for ${teacherRecord.nama} (${scan_id}) - expires ${qrData.expiry}`);

      res.json({
        success: true,
        data: qrData
      });
    } catch (error) {
      console.error('[QR GENERATE ERROR]', error.message);
      res.status(500).json({ success: false, message: 'Error generating QR data' });
    }
  });

  /**
   * GET /api/scanner/devices
   * Admin: List all scanner devices with status
   */
  app.get('/api/scanner/devices', authenticateToken, async (req, res) => {
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

  /**
   * POST /api/scanner/devices
   * Admin: Create new scanner device
   */
  app.post('/api/scanner/devices', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const { device_id, tenant_id, school_name, device_name } = req.body;

      if (!device_id || !tenant_id || !school_name) {
        return res.status(400).json({ success: false, message: 'device_id, tenant_id, dan school_name wajib diisi' });
      }

      // Check duplicate device_id
      const existing = await db.query('SELECT id FROM scanner_devices WHERE device_id = ?', [device_id]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Device ID sudah digunakan' });
      }

      // Verify tenant
      const tenant = await db.query('SELECT tenant_id FROM tenants WHERE tenant_id = ?', [tenant_id]);
      if (tenant.length === 0) {
        return res.status(404).json({ success: false, message: 'Sekolah tidak ditemukan' });
      }

      const secret_key = crypto.randomBytes(32).toString('hex');

      const result = await db.query(
        'INSERT INTO scanner_devices (device_id, tenant_id, school_name, secret_key, device_name, status) VALUES (?, ?, ?, ?, ?, ?)',
        [device_id, tenant_id, school_name, secret_key, device_name || 'Scanner Device', 'active']
      );

      console.log(`[SCANNER CREATE] Device ${device_id} created by admin`);

      res.json({
        success: true,
        message: 'Scanner device berhasil dibuat',
        data: {
          id: result.insertId,
          device_id,
          secret_key, // Show only once!
          tenant_id,
          school_name
        }
      });
    } catch (error) {
      console.error('[SCANNER CREATE ERROR]', error.message);
      res.status(500).json({ success: false, message: 'Error creating device' });
    }
  });

  /**
   * PUT /api/scanner/devices/:deviceId
   * Admin: Update device status
   */
  app.put('/api/scanner/devices/:deviceId', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const { deviceId } = req.params;
      const { status, device_name } = req.body;

      const updates = [];
      const values = [];

      if (status) {
        if (!['active', 'inactive', 'maintenance'].includes(status)) {
          return res.status(400).json({ success: false, message: 'Status tidak valid' });
        }
        updates.push('status = ?');
        values.push(status);
      }

      if (device_name !== undefined) {
        updates.push('device_name = ?');
        values.push(device_name);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada data yang diupdate' });
      }

      values.push(deviceId);
      const query = `UPDATE scanner_devices SET ${updates.join(', ')} WHERE device_id = ?`;
      const result = await db.query(query, values);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
      }

      res.json({ success: true, message: 'Device berhasil diupdate' });
    } catch (error) {
      console.error('[SCANNER UPDATE ERROR]', error.message);
      res.status(500).json({ success: false, message: 'Error updating device' });
    }
  });

  /**
   * DELETE /api/scanner/devices/:deviceId
   * Admin: Delete scanner device (soft delete by setting inactive)
   */
  app.delete('/api/scanner/devices/:deviceId', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const { deviceId } = req.params;

      // Soft delete: set status = 'inactive'
      const result = await db.query(
        'UPDATE scanner_devices SET status = ? WHERE device_id = ?',
        ['inactive', deviceId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
      }

      console.log(`[SCANNER DELETE] Device ${deviceId} deactivated by admin`);

      res.json({ success: true, message: 'Device berhasil dinonaktifkan' });
    } catch (error) {
      console.error('[SCANNER DELETE ERROR]', error.message);
      res.status(500).json({ success: false, message: 'Error deleting device' });
    }
  });

  /**
   * GET /api/scanner/attendance/logs
   * Admin: View all scanner attendance logs (with filters)
   */
  app.get('/api/scanner/attendance/logs', authenticateToken, async (req, res) => {
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

// ============================================
    // EVALUATION ENDPOINTS
    // ============================================
    
    // Get teachers for evaluation (by evaluator's tenant)
    app.get('/api/evaluations/teachers', authenticateToken, async (req, res) => {
      try {
        let tenantId = req.query.tenant_id;
        
        // Determine accessible tenants based on user role
        if (req.user.role === 'admin' && !tenantId) {
          return res.status(400).json({ success: false, message: 'tenant_id required for admin' });
        }
        
        // For guru with kepala_sekolah/pimpinan_pondok role, use their assigned tenant
        if (!tenantId) {
          const assignments = req.user.assignments || [];
          const relevantAssignments = assignments.filter(a => 
            ['kepala_sekolah', 'pimpinan_pondok'].includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
          );
          if (relevantAssignments.length > 0) {
            tenantId = relevantAssignments[0].tenant_id;
          }
        }
        
        if (!tenantId) {
          return res.status(400).json({ success: false, message: 'No accessible tenant found' });
        }
        
        // Verify access for non-admin
        if (req.user.role === 'guru') {
          const assignments = req.user.assignments || [];
          const hasAccess = assignments.some(a => 
            a.tenant_id === tenantId && 
            ['kepala_sekolah', 'pimpinan_pondok'].includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
          );
          if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Access denied to this tenant' });
          }
        }
        
        // Get teachers for this tenant
        const teachers = await db.query(`
          SELECT t.id, t.nama, t.scan_id, t.jenis_kelamin
          FROM teachers t
          JOIN teacher_assignments ta ON t.id = ta.teacher_id
          WHERE ta.tenant_id = ? AND t.status_aktif = 1
          ORDER BY t.nama ASC
        `, [tenantId]);
        
        res.json({ success: true, data: teachers });
      } catch (error) {
        console.error('Get teachers for evaluation error:', error);
        res.status(500).json({ success: false, message: 'Error fetching teachers' });
      }
    });

    // Get my evaluations (for kepala sekolah/pimpinan pondok to see their given evaluations)
    app.get('/api/evaluations/my-evaluations', authenticateToken, async (req, res) => {
      try {
        if (req.user.role !== 'guru' && req.user.role !== 'admin') {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
        
        let query = `
          SELECT e.*, t.nama as teacher_name, tn.nama_sekolah
          FROM evaluations e
          JOIN teachers t ON e.teacher_id = t.id
          LEFT JOIN tenants tn ON e.tenant_id = tn.tenant_id
          WHERE 1=1
        `;
        let params = [];
        
        if (req.user.role === 'guru') {
          query += ' AND e.evaluator_id = ?';
          params.push(req.user.id);
        }
        
        query += ' ORDER BY e.evaluation_date DESC, e.created_at DESC LIMIT 100';
        
        const evaluations = await db.query(query, params);
        res.json({ success: true, data: evaluations });
      } catch (error) {
        console.error('Get my evaluations error:', error);
        res.status(500).json({ success: false, message: 'Error fetching evaluations' });
      }
    });

    // Get evaluations summary (average score per teacher)
    app.get('/api/evaluations/summary', authenticateToken, async (req, res) => {
      try {
        let tenantId = req.query.tenant_id;
        
        // Determine accessible tenant for non-admin
        if (req.user.role === 'guru' && !tenantId) {
          const assignments = req.user.assignments || [];
          const relevantAssignments = assignments.filter(a => 
            ['kepala_sekolah', 'pimpinan_pondok'].includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
          );
          if (relevantAssignments.length > 0) {
            tenantId = relevantAssignments[0].tenant_id;
          }
        }
        
        let query = `
          SELECT 
            t.id as teacher_id,
            t.nama as teacher_name,
            COALESCE(AVG(e.score), 0) as avg_score,
            COUNT(e.id) as evaluation_count
          FROM teachers t
          JOIN teacher_assignments ta ON t.id = ta.teacher_id
          LEFT JOIN evaluations e ON t.id = e.teacher_id
        `;
        let params = [];
        let whereAdded = false;
        
        if (tenantId) {
          query += ' WHERE ta.tenant_id = ?';
          params.push(tenantId);
          whereAdded = true;
        }
        
        query += ' GROUP BY t.id, t.nama ORDER BY avg_score DESC';
        
        const summary = await db.query(query, params);
        res.json({ success: true, data: summary });
      } catch (error) {
        console.error('Get evaluations summary error:', error);
        res.status(500).json({ success: false, message: 'Error fetching summary' });
      }
    });

    // Create evaluation
    app.post('/api/evaluations', authenticateToken, async (req, res) => {
      try {
        const { teacher_id, score, category, notes, evaluation_date } = req.body;
        
        if (!teacher_id || score === undefined) {
          return res.status(400).json({ success: false, message: 'teacher_id and score required' });
        }
        
        // Validate score (1-5)
        if (score < 1 || score > 5) {
          return res.status(400).json({ success: false, message: 'Score must be between 1 and 5' });
        }
        
        // Determine tenant from teacher's assignment
        const [assignment] = await db.query(
          'SELECT tenant_id FROM teacher_assignments WHERE teacher_id = ? LIMIT 1',
          [teacher_id]
        );
        
        if (!assignment) {
          return res.status(404).json({ success: false, message: 'Teacher not found or not assigned to any tenant' });
        }
        
        const tenant_id = assignment.tenant_id;
        
        // Verify evaluator access - only kepala_sekolah/pimpinan_pondok can evaluate
        if (req.user.role === 'guru') {
          const assignments = req.user.assignments || [];
          const hasAccess = assignments.some(a => 
            a.tenant_id === tenant_id && 
            ['kepala_sekolah', 'pimpinan_pondok'].includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
          );
          if (!hasAccess) {
            return res.status(403).json({ success: false, message: 'Only kepala sekolah or pimpinan pondok can evaluate teachers' });
          }
        } else if (req.user.role === 'admin') {
          // Admin can evaluate anyone - access granted
        } else {
          return res.status(403).json({ success: false, message: 'Insufficient permissions' });
        }
        
        const evaluator_id = req.user.id;
        
        const result = await db.query(
          `INSERT INTO evaluations (teacher_id, evaluator_id, tenant_id, score, category, notes, evaluation_date) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [teacher_id, evaluator_id, tenant_id, score, category || 'kehadiran', notes || '', evaluation_date || new Date().toISOString().split('T')[0]]
        );
        
        res.json({ success: true, message: 'Evaluation recorded', data: { id: result.insertId } });
      } catch (error) {
        console.error('Create evaluation error:', error);
        res.status(500).json({ success: false, message: 'Error creating evaluation' });
      }
    });

    // Get evaluations (for viewing)
    app.get('/api/evaluations', authenticateToken, async (req, res) => {
      try {
        let tenantId = req.query.tenant_id;
        const teacherId = req.query.teacher_id;
        
        // Determine accessible tenant for non-admin
        if (req.user.role === 'guru' && !tenantId) {
          const assignments = req.user.assignments || [];
          const relevantAssignments = assignments.filter(a => 
            ['kepala_sekolah', 'pimpinan_pondok'].includes((a.jabatan_di_unit || '').toLowerCase().replace(/\s/g, ''))
          );
          if (relevantAssignments.length > 0) {
            tenantId = relevantAssignments[0].tenant_id;
          }
        }
        
        let query = `
          SELECT e.*, t.nama as teacher_name, u.username as evaluator_name
          FROM evaluations e
          JOIN teachers t ON e.teacher_id = t.id
          JOIN users u ON e.evaluator_id = u.id
          WHERE 1=1
        `;
        const params = [];
        
        if (tenantId) {
          query += ' AND e.tenant_id = ?';
          params.push(tenantId);
        }
        
        if (teacherId) {
          query += ' AND e.teacher_id = ?';
          params.push(teacherId);
        }
        
        query += ' ORDER BY e.evaluation_date DESC, e.created_at DESC LIMIT 100';
        
        const evaluations = await db.query(query, params);
        
        res.json({ success: true, data: evaluations });
      } catch (error) {
        console.error('Get evaluations error:', error);
        res.status(500).json({ success: false, message: 'Error fetching evaluations' });
      }
    });

// ============================================
    // AUTOMATIC EVALUATION FROM ATTENDANCE
    // ============================================

    async function calculateAutoEvaluation(teacher_id, tenant_id, month = null) {
      if (!month) {
        const now = new Date();
        month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      }

      try {
        const stats = await db.query(`
          SELECT 
            COUNT(*) as total_days,
            SUM(CASE WHEN status = 'hadir' THEN 1 ELSE 0 END) as present_days,
            SUM(CASE WHEN status = 'telat' THEN 1 ELSE 0 END) as late_days,
            SUM(CASE WHEN status = 'alpha' OR status IS NULL THEN 1 ELSE 0 END) as alpha_days
          FROM absensi 
          WHERE teacher_id = ? AND tenant_id = ? AND DATE_FORMAT(waktu_scan, '%Y-%m') = ?
          AND (status = 'hadir' OR status = 'telat' OR status = 'alpha')
        `, [teacher_id, tenant_id, month]);

        const stat = stats[0] || { total_days: 0, present_days: 0, late_days: 0, alpha_days: 0 };
        
        let score = 0;
        if (stat.total_days > 0) {
          const rate = (stat.present_days / stat.total_days) * 100;
          if (rate >= 95) score = 5.0;
          else if (rate >= 90) score = 4.5;
          else if (rate >= 85) score = 4.0;
          else if (rate >= 80) score = 3.5;
          else if (rate >= 75) score = 3.0;
          else if (rate >= 70) score = 2.5;
          else if (rate >= 65) score = 2.0;
          else score = 1.0;
        }

        return {
          score: parseFloat(score.toFixed(2)),
          total_days: stat.total_days,
          present_days: stat.present_days,
          late_days: stat.late_days,
          alpha_days: stat.alpha_days
        };
      } catch (error) {
        console.error('Auto evaluation error:', error);
        return { score: 0, total_days: 0, present_days: 0, late_days: 0, alpha_days: 0 };
      }
    }

    // Run auto evaluation for all teachers
    app.post('/api/evaluations/auto-calculate', authenticateToken, async (req, res) => {
      try {
        const userRole = req.user.role;
        const isAdmin = userRole === 'admin';
        
        // Get user's assigned tenant if not admin
        let tenantId = null;
        if (!isAdmin) {
          const assignments = await db.query(
            'SELECT tenant_id FROM teacher_assignments WHERE user_id = ? AND jabatan_di_unit IN (?, ?) LIMIT 1',
            [req.user.id, 'kepala_sekolah', 'pimpinan_pondok']
          );
          if (assignments.length === 0) {
            return res.status(403).json({ success: false, message: 'Akses ditolak' });
          }
          tenantId = assignments[0].tenant_id;
        }

        // Get teachers based on role
        let teachers;
        if (isAdmin) {
          teachers = await db.query('SELECT id, tenant_id FROM teachers WHERE status_aktif = 1');
        } else {
          teachers = await db.query('SELECT id, tenant_id FROM teachers WHERE status_aktif = 1 AND tenant_id = ?', [tenantId]);
        }
        
        const results = [];

        for (const teacher of teachers) {
          const evalData = await calculateAutoEvaluation(teacher.id, teacher.tenant_id);
          
          if (evalData.total_days > 0 && evalData.score > 0) {
            await db.query(`
              INSERT INTO evaluations (teacher_id, evaluator_id, tenant_id, score, category, notes, evaluation_date)
              VALUES (?, NULL, ?, ?, 'kehadiran', ?, CURDATE())
              ON DUPLICATE KEY UPDATE score = VALUES(score), notes = VALUES(notes)
            `, [teacher.id, teacher.tenant_id, evalData.score, `Otomatis: ${evalData.present_days}/${evalData.total_days} hari hadir`]);
            
            results.push({ teacher_id: teacher.id, score: evalData.score });
          }
        }

        res.json({ success: true, message: `Berhasil menilai ${results.length} guru`, data: results });
      } catch (error) {
        console.error('Auto calculate error:', error);
        res.status(500).json({ success: false, message: 'Error auto calculating evaluations' });
      }
    });

    // Get all evaluations (for Ketua Yayasan - admin can see all)
    app.get('/api/evaluations/all', authenticateToken, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ success: false, message: 'Hanya Ketua Yayasan yang bisa melihat semua nilai' });
        }

        const query = `
          SELECT e.*, t.nama as teacher_name, tn.nama_sekolah, u.username as evaluator_name
          FROM evaluations e
          JOIN teachers t ON e.teacher_id = t.id
          JOIN tenants tn ON e.tenant_id = tn.tenant_id
          LEFT JOIN users u ON e.evaluator_id = u.id
          ORDER BY e.tenant_id, e.evaluation_date DESC
        `;

        const evaluations = await db.query(query);
        res.json({ success: true, data: evaluations });
      } catch (error) {
        console.error('Get all evaluations error:', error);
        res.status(500).json({ success: false, message: 'Error fetching all evaluations' });
      }
    });

    // Get evaluation summary across all schools (for Ketua Yayasan dashboard)
    app.get('/api/evaluations/yayasan-summary', authenticateToken, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ success: false, message: 'Hanya Ketua Yayasan yang bisa melihat ringkasan yayasan' });
        }

        const summary = await db.query(`
          SELECT 
            e.tenant_id,
            tn.nama_sekolah,
            COUNT(DISTINCT e.teacher_id) as total_guru,
            AVG(e.score) as avg_score,
            MIN(e.score) as min_score,
            MAX(e.score) as max_score
          FROM evaluations e
          JOIN tenants tn ON e.tenant_id = tn.tenant_id
          WHERE e.evaluation_date >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
          GROUP BY e.tenant_id, tn.nama_sekolah
          ORDER BY avg_score DESC
        `);

        res.json({ success: true, data: summary });
      } catch (error) {
        console.error('Yayasan summary error:', error);
        res.status(500).json({ success: false, message: 'Error fetching yayasan summary' });
      }
    });

    // ============================================
    // END EVALUATION ENDPOINTS
    // ============================================

    app.listen(PORT, '0.0.0.0', () => {
      console.log('🚀 Server YPWI Lutim berjalan di http://localhost:' + PORT);
      console.log('🌐 Juga dapat diakses di http://0.0.0.0:' + PORT + ' atau IP lokal Anda');
      console.log('🔐 Login endpoint: POST /api/auth/login');
      console.log('📊 Dashboard endpoint: GET /api/dashboard (protected)');
      console.log('📱 Scanner endpoints: POST /api/scanner/attendance, POST /api/scanner/register');
      console.log('🔍 QR Generator: GET /api/scanner/qr/generate?scan_id=XXX');
    });
  }

startServer().catch(err => {
  console.error('Server start failed:', err.message);
  process.exit(1);
});