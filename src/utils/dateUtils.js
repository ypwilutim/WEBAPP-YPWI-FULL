// ============================================================
// DATE UTILS
// Helper functions for date and rule matching
// ============================================================

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

module.exports = {
  isDayMatch
};
