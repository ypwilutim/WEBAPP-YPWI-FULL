-- Create evaluations table for teacher evaluation system
-- Run this SQL in your database

CREATE TABLE IF NOT EXISTS evaluations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  teacher_id INT NOT NULL,
  evaluator_id INT NULL,
  tenant_id VARCHAR(20) NOT NULL,
  score DECIMAL(3,2) NOT NULL CHECK (score >= 0 AND score <= 5),
  category ENUM('kehadiran', 'disiplin', 'profesionalisme', 'komunikasi', 'kepemimpinan') DEFAULT 'kehadiran',
  notes TEXT,
  evaluation_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_teacher_id (teacher_id),
  INDEX idx_evaluator_id (evaluator_id),
  INDEX idx_tenant_id (tenant_id),
  INDEX idx_evaluation_date (evaluation_date),
  UNIQUE KEY unique_teacher_month (teacher_id, tenant_id, evaluation_date),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluator_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Store automatic evaluation records
CREATE TABLE IF NOT EXISTS teacher_attendance_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  teacher_id INT NOT NULL,
  tenant_id VARCHAR(20) NOT NULL,
  month YEAR(4) NOT NULL,
  total_days INT DEFAULT 0,
  present_days INT DEFAULT 0,
  late_days INT DEFAULT 0,
  alpha_days INT DEFAULT 0,
  attendance_rate DECIMAL(5,2) DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_teacher_month (teacher_id, tenant_id, month),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

-- To verify the table was created:
-- SHOW TABLES LIKE 'evaluations';
-- SHOW TABLES LIKE 'teacher_attendance_stats';
-- DESCRIBE evaluations;
-- DESCRIBE teacher_attendance_stats;