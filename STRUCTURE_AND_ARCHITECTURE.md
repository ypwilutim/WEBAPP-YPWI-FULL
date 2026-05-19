# YPWI Lutim - Web Application Structure & Architecture

**Dokumen:** Sistem Informasi Kehadiran & Evaluasi Guru  
**Tech Stack:** Node.js + Express + MySQL | HTML/CSS/JS Frontend

---

## FILE STRUCTURE (Updated - Modular Architecture)

```
E:\YPWI WEBAPP\
├── server.js                    # Main backend server (minimal ~3950 lines)
├── db.js                        # Database connection pool
├── package.json
├── .env
├── setup-evaluations.sql
├── src/
│   ├── routes/
│   │   ├── adminRoutes.js       # Semua /api/admin/* (tenants, teachers, locations, rules, whatsapp, evaluations, dll)
│   │   ├── authRoutes.js        # Login, profile, forgot-password
│   │   └── scannerRoutes.js     # QR Scanner & device management
│   ├── middlewares/
│   │   ├── auth.js              # authenticateToken, authenticateOperator, verifyTenantAccess
│   │   └── logger.js            # Robust request logger + error stack trace
│   └── utils/
│       └── dateUtils.js         # isDayMatch helper
├── public\
│   ├── login.html
│   ├── dashboard.html
│   ├── master-dashboard.html
│   ├── school-admin.html
│   ├── admin-dashboard.html
│   ├── evaluation-dashboard.html
│   ├── search-teacher.html
│   └── ...
├── views\
│   └── monthly-report-template.ejs
└── logs\
    └── app.log
```

---

## FEATURES BY FILE

### 1. **server.js** (Main Backend - Minimal & Clean)

Server.js sekarang hanya berisi:
- Inisialisasi Express + middleware global
- Registrasi route modular
- `app.listen()`

Semua business logic dan rute sudah dipindahkan ke `src/routes/`.

#### Authentication & Authorization
- `POST /api/auth/login` - User login with JWT token
- `POST /api/auth/logout` - Logout
- `POST /api/change-password` - Change user password

#### User Roles & Dashboard
- `GET /api/dashboard` - Dashboard data (attendance summary, today's status)
- `GET /api/teacher/info` - Teacher profile & assignments
- `GET /api/teacher-assignments` - Get teacher's unit assignments

#### Attendance System
- `GET /api/attendance-history` - Teacher's attendance history
- `POST /api/attendance` - Record attendance (masuk/pulang)
- `GET /api/units/nearby` - Find nearest school unit
- `GET /api/units/all` - Get all school units with coordinates
- `GET /api/admin/attendance-logs` - Admin attendance logs

#### Teacher Management (Admin)
- `GET /api/teachers` - All teachers (with sekolah info)
- `POST /api/admin/teachers` - Add new teacher
- `GET /api/admin/tenants` - All school units
- `POST /api/admin/tenants` - Add new school unit
- `GET /api/teachers/assignments/bulk` - Bulk teacher assignments
- `POST /api/teachers/:id/assignments` - Assign teacher to unit
- `DELETE /api/teachers/:id/assignments` - Remove assignment

#### Evaluation System
- `GET /api/evaluations/my-evaluations` - Teacher's own evaluations
- `GET /api/evaluations/summary` - Evaluation summary per unit
- `POST /api/evaluations` - Create manual evaluation
- `GET /api/evaluations` - Get evaluations (by unit)
- `GET /api/evaluations/all` - All evaluations (admin)
- `GET /api/evaluations/yayasan-summary` - Yayasan-wide summary
- `POST /api/evaluations/auto-calculate` - Auto-calculate from attendance

#### Admin Summary
- `GET /api/admin/summary` - Overview stats (schools, teachers)

---

### 2. **dashboard.html** (Guru Dashboard - 1289 lines)

#### Core Features:
1. **GPS Attendance**
   - Real-time location detection via Geolocation API
   - Radius validation (max 200m from school)
   - "Dinas Luar" feature for teachers at other units

2. **Attendance Recording**
   - Absen Masuk button
   - Absen Pulang button
   - Offline attendance support (localStorage sync)

3. **Today's Summary**
   - Total attendance count
   - Last status (Belum absen / Hadir)
   - Last time

4. **Attendance History**
   - Recent attendance records
   - Status badges (Tepat Waktu/Terlambat)

5. **Role-Based Navigation**
   - Ketua Yayasan → master-dashboard.html button
   - Admin/TU → school-admin.html button
   - Kepala Sekolah/Pimpinan → evaluation-dashboard.html button

6. **Profile Management**
   - Photo upload
   - Change password modal
   - Default password detection

---

### 3. **master-dashboard.html** (Ketua Yayasan Dashboard - 754 lines)

#### 8 Main Tabs:

| Tab | Features |
|-----|----------|
| **Overview** | Stats: total sekolah, guru, hadir hari ini, rata-rata nilai. Per-sekolah breakdown. |
| **Sekolah** | Manage schools: add, edit, view teachers per school |
| **Kepala** | Assign kepala_sekolah/pimpinan_pondok roles to teachers |
| **Guru** | View all teachers across yayasan, filter by school |
| **Kehadiran** | Attendance logs for all teachers, filter by date/school |
| **Evaluasi** | Auto-evaluation run, per-school summary, recent scores |
| **Penggajian** | Salary management (placeholder) |
| **HR** | Contract, letter, leave management (placeholder) |

#### Auto-Evaluation Algorithm:
```javascript
// Based on attendance rate calculation
rate = (present_days / total_days) * 100
95%+    → 5.0
90-94%  → 4.5
85-89%  → 4.0
80-84%  → 3.5
75-79%  → 3.0
70-74%  → 2.5
65-69%  → 2.0
<65%    → 1.0
```

---

### 4. **evaluation-dashboard.html**

#### Features:
- Auto tenant detection from URL parameters
- Auto-calculate evaluations for assigned unit
- View evaluations per teacher
- Evaluation history

---

### 5. **school-admin.html**

#### Features:
- School-specific admin dashboard
- Manage teachers at that school
- View attendance reports
- Scan QR for attendance

---

## DATABASE SCHEMA

### Core Tables:
```sql
-- Users & Authentication
users (id, username, password, role, tenant_id, guru_id, is_profile_complete)

-- Teacher Master Data
teachers (id, nama, nik, jenis_kelamin, alamat, no_wa, email, status_aktif, ...)

-- Assignments (Many-to-Many)
teacher_assignments (
  id, teacher_id, tenant_id, 
  jabatan_di_unit,  -- kepala_sekolah/pimpinan_pondok/ketua_yayasaan
  PRIMARY KEY unique per teacher-tenant
)

-- Attendance
attendance_logs (
  id, teacher_id, tenant_id,
  jenis (masuk/pulang),
  status (hadir/telat/alpha),
  waktu_scan, latitude, longitude
)

-- Tenants (Schools/Units)
tenants (
  tenant_id, nama_sekolah, alamat,
  latitude, longitude, location_radius
)

-- Evaluations (NEW)
evaluations (
  id, teacher_id, evaluator_id, tenant_id,
  score, category (kehadiran/disiplin/profesionalisme/...),
  notes, evaluation_date
)

teacher_attendance_stats (
  id, teacher_id, tenant_id, month,
  total_days, present_days, late_days, alpha_days,
  attendance_rate
)
```

---

## USER ROLES & PERMISSIONS

| Role | Login Redirect | Dashboard Access | Special Features |
|------|----------------|------------------|------------------|
| **guru** | dashboard.html | Personal attendance, history | None |
| **admin** | school-admin.html | Manage assigned school | School admin |
| **ketua_yayasaan** | dashboard.html | master-dashboard.html | All schools view |
| **kepala_sekolah** | dashboard.html | evaluation-dashboard.html | Evaluate teachers |
| **pimpinan_pondok** | dashboard.html | evaluation-dashboard.html | Evaluate teachers |

---

## API ENDPOINTS SUMMARY

### Public:
- `POST /api/auth/login`

### Authenticated (Token required):
- `GET /api/dashboard`
- `GET /api/teacher/info`
- `GET /api/attendance-history`
- `POST /api/attendance`

### Admin Only:
- `GET /api/admin/summary`
- `GET /api/admin/tenants`
- `POST /api/admin/tenants`
- `GET /api/admin/attendance-logs`
- `POST /api/admin/teachers`

### Evaluation:
- `GET /api/evaluations/*` - Various access levels
- `POST /api/evaluations/auto-calculate`

---

## KEY BUSINESS LOGIC

### 1. Attendance Types:
- **masuk** = Absen Masuk
- **pulang** = Absen Pulang
- **status**: hadir (on time), telat (late), alpha (absent)

### 2. Location Validation:
- GPS accuracy required
- Must be within 200m of assigned school OR
- Can do "dinas luar" at nearby unit

### 3. Evaluation Categories:
- kehadiran (attendance-based auto)
- disiplin
- profesionalisme
- komunikasi
- kepemimpinan

### 4. Auto-Evaluation Triggers:
- Manual: "Jalankan Auto-Evaluasi" button
- Calculates from attendance_logs attendance rate

---

## FRONTEND COMPONENTS

### UI Libraries:
- TailwindCSS
- Font Awesome 6.0
- SweetAlert2

### Key JavaScript Functions (dashboard.html):
- `setTeacherInfo()` - Load user profile & show role buttons
- `requestLocationPermission()` - Initialize GPS
- `updateAttendanceButtonsState()` - Enable/disable absen buttons
- `recordAttendance(jenis)` - Submit attendance
- `validateLocationRadius()` - Check if within school radius
- `checkDinasLuar()` - Check dinas luar eligibility
- `calculateDistance()` - Haversine formula for distance

---

## ENVIRONMENT CONFIGURATION (.env)

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=***
DB_NAME=ypwi_absensi
JWT_SECRET=***
WHATSAPP_ENDPOINT=***
WHATSAPP_DEVICE_ID=***
```

---

## DEVELOPMENT COMMANDS

```bash
# Install dependencies
npm install

# Run server
node server.js

# TailorCSS build (if needed)
npm run build:css

# Database migration (manual)
# Execute setup-evaluations.sql in MySQL
```

---

## TODO / FUTURE ENHANCEMENTS

- [ ] Penggajian module implementation
- [ ] HR contracts, letters, leave management
- [ ] Push notifications for WhatsApp
- [ ] Monthly report PDF generation
- [ ] Mobile app (PWA already partially configured)