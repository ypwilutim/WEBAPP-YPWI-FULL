-- ============================================================
-- MIGRATION: Attendance Rules System for Multi-Unit Support
-- Date: 2026-05-17
-- Purpose: Support different attendance rules for Yayasan, Sekolah, Pondok
-- ============================================================

-- 1. UPDATE tenants TABLE - Add tipe_unit column
ALTER TABLE tenants 
ADD COLUMN tipe_unit ENUM('yayasan', 'sekolah', 'pondok') NOT NULL DEFAULT 'sekolah' 
AFTER tenant_id;

-- UPDATE existing rows to have appropriate tipe_unit based on naming convention
UPDATE tenants SET tipe_unit = 'sekolah' WHERE tenant_id LIKE 'YPWI%';
UPDATE tenants SET tipe_unit = 'pondok' WHERE tenant_id LIKE '%PONDOK%' OR tenant_id LIKE '%ASRAMA%';
UPDATE tenants SET tipe_unit = 'yayasan' WHERE tenant_id LIKE '%YAYASAN%' OR tenant_id = 'YAYASAN';

-- 2. CREATE attendance_rules TABLE - Define working hours per unit
CREATE TABLE IF NOT EXISTS attendance_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(20) NOT NULL,
    nama_aturan VARCHAR(100) NOT NULL DEFAULT 'Default Rule',
    jam_masuk TIME NOT NULL DEFAULT '07:00:00',
    jam_pulang TIME NOT NULL DEFAULT '16:00:00',
    toleransi_terlambat INT DEFAULT 15 COMMENT 'Menit toleransi keterlambatan',
    hari_kerja VARCHAR(50) NOT NULL DEFAULT 'senin,selasa,rabu,kamis,jumat,sabtu' 
        COMMENT 'Hari kerja: senin,selasa,... atau sabtu,sunyi untuk pondok',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes
    INDEX idx_tenant_active (tenant_id, is_active),
    INDEX idx_nama_aturan (nama_aturan),
    
    -- Foreign Key
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. UPDATE attendance_logs TABLE - Add rule_id reference
ALTER TABLE attendance_logs 
ADD COLUMN rule_id INT NULL AFTER teacher_id,
ADD INDEX idx_rule_id (rule_id),
ADD FOREIGN KEY (rule_id) REFERENCES attendance_rules(id) ON DELETE SET NULL;

-- 4. INSERT DEFAULT RULES for existing tenants (one default rule per tenant)
INSERT INTO attendance_rules (tenant_id, nama_aturan, jam_masuk, jam_pulang, toleransi_terlambat, hari_kerja)
SELECT 
    tenant_id,
    CONCAT('Default - ', nama_sekolah) as nama_aturan,
    '07:00:00' as jam_masuk,
    '16:00:00' as jam_pulang,
    15 as toleransi_terlambat,
    CASE 
        WHEN tipe_unit = 'pondok' THEN 'senin,selasa,rabu,kamis,jumat,sabtu,minggu'
        WHEN tipe_unit = 'yayasan' THEN 'senin,selasa,rabu,kamis,jumat'
        ELSE 'senin,selasa,rabu,kamis,jumat,sabtu'
    END as hari_kerja
FROM tenants
WHERE tenant_id NOT IN (SELECT DISTINCT tenant_id FROM attendance_rules);

-- 5. ADD CONSTRAINT for better data integrity (optional - uncomment if needed)
-- ALTER TABLE attendance_logs ADD CONSTRAINT chk_jenis CHECK (jenis IN ('masuk', 'pulang', 'dinas_luar'));

-- ============================================================
-- VERIFICATION QUERIES (Run after migration)
-- ============================================================
-- SELECT 'Tenants with tipe_unit' as check_name, COUNT(*) as count FROM tenants;
-- SELECT 'Rules created' as check_name, COUNT(*) as count FROM attendance_rules;
-- SELECT tenant_id, tipe_unit, nama_sekolah FROM tenants LIMIT 10;
-- SELECT id, tenant_id, nama_aturan, jam_masuk, jam_pulang FROM attendance_rules LIMIT 10;