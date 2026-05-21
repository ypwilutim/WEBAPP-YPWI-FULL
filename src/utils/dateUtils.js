// ============================================================
// DATE UTILS
// Helper functions for date and rule matching
// ============================================================

function isDayMatch(ruleHari, currentDay) {
  // ... (kode isDayMatch Anda yang lama tetap di sini) ...
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

// --- TAMBAHAN BARU: FUNGSI KONVERSI UTC ---

function toUTC(date = new Date()) {
  const d = new Date(date);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() + offset);
}

function getUTCISO(date = new Date()) {
  return toUTC(date).toISOString();
}

function getSQLFormat(date = new Date()) {
  return toUTC(date).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  isDayMatch,
  toUTC,
  getUTCISO,
  getSQLFormat,
};
