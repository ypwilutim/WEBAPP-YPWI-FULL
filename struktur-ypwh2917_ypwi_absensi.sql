-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Waktu pembuatan: 17 Bulan Mei 2026 pada 09.13
-- Versi server: 10.4.32-MariaDB
-- Versi PHP: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `ypwh2917_ypwi_absensi`
--

-- --------------------------------------------------------

--
-- Struktur dari tabel `attendance_logs`
--

CREATE TABLE `attendance_logs` (
  `id` bigint(20) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `rule_id` int(11) DEFAULT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `waktu_scan` datetime NOT NULL,
  `jenis` enum('masuk','pulang') NOT NULL,
  `metode` enum('dashboard','scanner') NOT NULL DEFAULT 'scanner',
  `status` enum('tepat_waktu','terlambat') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `selfie_url` varchar(255) DEFAULT NULL,
  `dinas_luar` tinyint(1) DEFAULT 0,
  `kegiatan_dinas` text DEFAULT NULL,
  `latitude` decimal(10,8) DEFAULT NULL,
  `longitude` decimal(11,8) DEFAULT NULL,
  `keterangan` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `attendance_rules`
--

CREATE TABLE `attendance_rules` (
  `id` int(11) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `tipe` enum('Datang','Pulang') NOT NULL,
  `jam_mulai` time NOT NULL,
  `jam_selesai` time NOT NULL,
  `keterangan` varchar(255) DEFAULT NULL,
  `status_log` enum('tepat_waktu','terlambat') NOT NULL,
  `hari` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `evaluations`
--

CREATE TABLE `evaluations` (
  `id` int(11) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `evaluator_id` int(11) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `score` int(11) NOT NULL CHECK (`score` >= 1 and `score` <= 5),
  `category` enum('kehadiran','disiplin','profesionalisme','komunikasi','kepemimpinan') DEFAULT 'kehadiran',
  `notes` text DEFAULT NULL,
  `evaluation_date` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `qr_attendance_logs`
--

CREATE TABLE `qr_attendance_logs` (
  `id` int(11) NOT NULL,
  `scan_id` varchar(20) NOT NULL,
  `teacher_id` int(11) DEFAULT NULL,
  `device_id` varchar(100) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `waktu_scan` datetime NOT NULL,
  `jenis` enum('masuk','pulang') NOT NULL,
  `signature` varchar(255) NOT NULL,
  `sync_status` enum('pending','synced','failed','rejected') DEFAULT 'pending',
  `error_message` text DEFAULT NULL,
  `offline_validated` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `synced_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `scanner_devices`
--

CREATE TABLE `scanner_devices` (
  `id` int(11) NOT NULL,
  `device_id` varchar(100) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `school_name` varchar(100) NOT NULL,
  `secret_key` varchar(255) NOT NULL,
  `status` enum('active','inactive','maintenance') DEFAULT 'active',
  `last_sync` datetime DEFAULT NULL,
  `device_name` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `teachers`
--

CREATE TABLE `teachers` (
  `id` int(11) NOT NULL,
  `nama` varchar(100) NOT NULL,
  `nik` varchar(20) NOT NULL,
  `tempat_lahir` varchar(50) DEFAULT NULL,
  `tanggal_lahir` date DEFAULT NULL,
  `jenis_kelamin` enum('L','P') DEFAULT NULL,
  `alamat` text DEFAULT NULL,
  `no_wa` varchar(20) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `status_kepegawaian` varchar(50) DEFAULT NULL,
  `tmt` date DEFAULT NULL,
  `nip` varchar(50) DEFAULT NULL,
  `scan_id` varchar(20) DEFAULT NULL,
  `link_foto` varchar(255) DEFAULT NULL,
  `status_aktif` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Trigger `teachers`
--
DELIMITER $$
CREATE TRIGGER `before_teacher_insert` BEFORE INSERT ON `teachers` FOR EACH ROW BEGIN
    -- Jika TMT sudah 2 tahun atau lebih, NIP wajib diisi (tidak boleh NIK-RANDOM atau Kosong)
    IF NEW.tmt <= DATE_SUB(CURDATE(), INTERVAL 2 YEAR) THEN
        IF NEW.nip IS NULL OR NEW.nip = '' OR NEW.nip = '-' THEN
            SIGNAL SQLSTATE '45000' 
            SET MESSAGE_TEXT = 'Error #1644 - NIP wajib diisi jika TMT sudah 2 tahun atau lebih';
        END IF;
    END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Struktur dari tabel `teacher_assignments`
--

CREATE TABLE `teacher_assignments` (
  `id` int(11) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `jabatan_di_unit` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `teacher_attendance_stats`
--

CREATE TABLE `teacher_attendance_stats` (
  `id` int(11) NOT NULL,
  `teacher_id` int(11) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `month` year(4) NOT NULL,
  `total_days` int(11) DEFAULT 0,
  `present_days` int(11) DEFAULT 0,
  `late_days` int(11) DEFAULT 0,
  `alpha_days` int(11) DEFAULT 0,
  `attendance_rate` decimal(5,2) DEFAULT 0.00,
  `last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `temp_teachers`
--

CREATE TABLE `temp_teachers` (
  `Nama` varchar(255) DEFAULT NULL,
  `NIY` varchar(100) DEFAULT NULL,
  `NIK` varchar(100) DEFAULT NULL,
  `Jenis_Kelamin` varchar(50) DEFAULT NULL,
  `Tempat_Lahir` varchar(100) DEFAULT NULL,
  `Tanggal_Lahir` varchar(100) DEFAULT NULL,
  `Alamat` text DEFAULT NULL,
  `No_WA` varchar(50) DEFAULT NULL,
  `Email` varchar(255) DEFAULT NULL,
  `tenant_id` varchar(50) DEFAULT NULL,
  `Jenjang` varchar(100) DEFAULT NULL,
  `Jabatan` varchar(100) DEFAULT NULL,
  `Status_Kepegawaian` varchar(100) DEFAULT NULL,
  `TMT` varchar(100) DEFAULT NULL,
  `Status_Aktif` varchar(50) DEFAULT NULL,
  `Keterangan` text DEFAULT NULL,
  `Link_Foto` varchar(255) DEFAULT NULL,
  `Terima_Notifikasi` varchar(20) DEFAULT NULL,
  `Gaji_Pokok` varchar(100) DEFAULT NULL,
  `Tunj_Kinerja` varchar(100) DEFAULT NULL,
  `Tunj_Umum` varchar(100) DEFAULT NULL,
  `Tunj_Istri` varchar(100) DEFAULT NULL,
  `Tunj_Anak` varchar(100) DEFAULT NULL,
  `Tunj_Kepala_Sekolah` varchar(100) DEFAULT NULL,
  `Tunj_Wali_Kelas` varchar(100) DEFAULT NULL,
  `Honor_Bendahara` varchar(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `tenants`
--

CREATE TABLE `tenants` (
  `tenant_id` varchar(20) NOT NULL,
  `tipe_unit` enum('yayasan','sekolah','pondok') NOT NULL DEFAULT 'sekolah',
  `nama_sekolah` varchar(100) NOT NULL,
  `absensi_method` enum('personal','gateway') NOT NULL DEFAULT 'personal',
  `wa_api_key` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `latitude` decimal(10,8) DEFAULT NULL,
  `longitude` decimal(11,8) DEFAULT NULL,
  `location_radius` int(11) DEFAULT 100,
  `location_name` varchar(255) DEFAULT NULL,
  `use_central_rules` tinyint(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `tenant_locations`
--

CREATE TABLE `tenant_locations` (
  `id` int(11) NOT NULL,
  `tenant_id` varchar(20) NOT NULL,
  `location_name` varchar(100) NOT NULL DEFAULT 'Lokasi Utama',
  `latitude` decimal(10,8) DEFAULT NULL,
  `longitude` decimal(11,8) DEFAULT NULL,
  `location_radius` int(11) DEFAULT 100,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Struktur dari tabel `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `username` varchar(50) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` enum('admin','guru') NOT NULL,
  `guru_id` int(11) DEFAULT NULL,
  `tenant_id` varchar(20) DEFAULT NULL,
  `is_profile_complete` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_default_password` tinyint(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indeks untuk tabel `attendance_logs`
--
ALTER TABLE `attendance_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_teacher_id` (`teacher_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`),
  ADD KEY `idx_waktu_scan` (`waktu_scan`),
  ADD KEY `idx_jenis` (`jenis`),
  ADD KEY `idx_rule_id` (`rule_id`);

--
-- Indeks untuk tabel `attendance_rules`
--
ALTER TABLE `attendance_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tenant_id` (`tenant_id`);

--
-- Indeks untuk tabel `evaluations`
--
ALTER TABLE `evaluations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `teacher_id` (`teacher_id`),
  ADD KEY `evaluator_id` (`evaluator_id`);

--
-- Indeks untuk tabel `qr_attendance_logs`
--
ALTER TABLE `qr_attendance_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_scan_id` (`scan_id`),
  ADD KEY `idx_device_id` (`device_id`),
  ADD KEY `idx_teacher_id` (`teacher_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`),
  ADD KEY `idx_sync_status` (`sync_status`),
  ADD KEY `idx_waktu_scan` (`waktu_scan`);

--
-- Indeks untuk tabel `scanner_devices`
--
ALTER TABLE `scanner_devices`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `device_id` (`device_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`),
  ADD KEY `idx_device_id` (`device_id`),
  ADD KEY `idx_status` (`status`);

--
-- Indeks untuk tabel `teachers`
--
ALTER TABLE `teachers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `nik` (`nik`),
  ADD UNIQUE KEY `scan_id` (`scan_id`),
  ADD KEY `idx_nik` (`nik`),
  ADD KEY `idx_scan_id` (`scan_id`),
  ADD KEY `idx_status_aktif` (`status_aktif`);

--
-- Indeks untuk tabel `teacher_assignments`
--
ALTER TABLE `teacher_assignments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_teacher_unit_job` (`teacher_id`,`tenant_id`,`jabatan_di_unit`),
  ADD KEY `idx_teacher_id` (`teacher_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`);

--
-- Indeks untuk tabel `teacher_attendance_stats`
--
ALTER TABLE `teacher_attendance_stats`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_teacher_month` (`teacher_id`,`tenant_id`,`month`);

--
-- Indeks untuk tabel `tenants`
--
ALTER TABLE `tenants`
  ADD PRIMARY KEY (`tenant_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`);

--
-- Indeks untuk tabel `tenant_locations`
--
ALTER TABLE `tenant_locations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tenant_id` (`tenant_id`),
  ADD KEY `idx_is_active` (`is_active`);

--
-- Indeks untuk tabel `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD KEY `idx_username` (`username`),
  ADD KEY `idx_guru_id` (`guru_id`),
  ADD KEY `idx_tenant_id` (`tenant_id`),
  ADD KEY `idx_role` (`role`);

--
-- AUTO_INCREMENT untuk tabel yang dibuang
--

--
-- AUTO_INCREMENT untuk tabel `attendance_logs`
--
ALTER TABLE `attendance_logs`
  MODIFY `id` bigint(20) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `attendance_rules`
--
ALTER TABLE `attendance_rules`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `evaluations`
--
ALTER TABLE `evaluations`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `qr_attendance_logs`
--
ALTER TABLE `qr_attendance_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `scanner_devices`
--
ALTER TABLE `scanner_devices`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `teachers`
--
ALTER TABLE `teachers`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `teacher_assignments`
--
ALTER TABLE `teacher_assignments`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `teacher_attendance_stats`
--
ALTER TABLE `teacher_attendance_stats`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `tenant_locations`
--
ALTER TABLE `tenant_locations`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT untuk tabel `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Ketidakleluasaan untuk tabel pelimpahan (Dumped Tables)
--

--
-- Ketidakleluasaan untuk tabel `attendance_logs`
--
ALTER TABLE `attendance_logs`
  ADD CONSTRAINT `attendance_logs_ibfk_1` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `attendance_logs_ibfk_2` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`tenant_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `attendance_logs_ibfk_3` FOREIGN KEY (`rule_id`) REFERENCES `attendance_rules` (`id`) ON DELETE SET NULL;

--
-- Ketidakleluasaan untuk tabel `evaluations`
--
ALTER TABLE `evaluations`
  ADD CONSTRAINT `evaluations_ibfk_1` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `evaluations_ibfk_2` FOREIGN KEY (`evaluator_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Ketidakleluasaan untuk tabel `qr_attendance_logs`
--
ALTER TABLE `qr_attendance_logs`
  ADD CONSTRAINT `qr_attendance_logs_ibfk_device` FOREIGN KEY (`device_id`) REFERENCES `scanner_devices` (`device_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `qr_attendance_logs_ibfk_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE SET NULL;

--
-- Ketidakleluasaan untuk tabel `teacher_assignments`
--
ALTER TABLE `teacher_assignments`
  ADD CONSTRAINT `teacher_assignments_ibfk_1` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `teacher_assignments_ibfk_2` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`tenant_id`) ON DELETE CASCADE;

--
-- Ketidakleluasaan untuk tabel `teacher_attendance_stats`
--
ALTER TABLE `teacher_attendance_stats`
  ADD CONSTRAINT `teacher_attendance_stats_ibfk_1` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE CASCADE;

--
-- Ketidakleluasaan untuk tabel `users`
--
ALTER TABLE `users`
  ADD CONSTRAINT `users_ibfk_1` FOREIGN KEY (`guru_id`) REFERENCES `teachers` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `users_ibfk_2` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`tenant_id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
