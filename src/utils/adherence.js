import { addDays, parseDate, toDateString } from './dates.js';

// ============================================================
// MONTHLY ATTENDANCE ADHERENCE — one person, one month. Pure maths, no database.
//
// Every working day (Mon–Fri) from the 1st (or the person's start date) up to
// today counts as ONE of:
//   onTime   clocked in, not late
//   late     clocked in after the branch start time (+ grace)
//   absent   no clock-in (or the clock-in was rejected by a manager)
//   onLeave  approved leave — not held against them
// Public holidays are skipped entirely. Today only counts once they've clocked in
// (the day isn't over yet).
//
//   adherence = onTime ÷ (onTime + late + absent)      ← the "expected" days
// ============================================================
export function monthAdherence({ month, today, startDate, records, leaves, holidays }) {
  const [y, m] = month.split('-').map(Number);
  const monthStart = toDateString(new Date(y, m - 1, 1));
  const monthEnd = toDateString(new Date(y, m, 0));
  const from = startDate && startDate > monthStart ? startDate : monthStart;
  const to = monthEnd < today ? monthEnd : today;

  const byDate = new Map(records.map((r) => [r.work_date, r]));
  const holidaySet = new Set(holidays);
  const onLeaveOn = (date) => leaves.some((l) => l.start_date <= date && l.end_date >= date);

  const result = { month, upTo: to, onTime: 0, late: 0, absent: 0, onLeave: 0, holidays: 0, flagged: 0 };
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = parseDate(date).getDay();
    if (weekday === 0 || weekday === 6) continue;
    if (holidaySet.has(date)) {
      result.holidays += 1;
      continue;
    }
    const record = byDate.get(date);
    if (record && record.review_status !== 'rejected') {
      if (record.is_late) result.late += 1;
      else result.onTime += 1;
      if (record.review_status === 'pending') result.flagged += 1;
    } else if (onLeaveOn(date)) {
      result.onLeave += 1;
    } else if (date < today) {
      result.absent += 1;
    }
  }

  result.expected = result.onTime + result.late + result.absent;
  result.adherence = result.expected ? Math.round((result.onTime / result.expected) * 100) : null;
  result.presentRate = result.expected ? Math.round(((result.onTime + result.late) / result.expected) * 100) : null;
  return result;
}

// "2026-11" → "2026-10"
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
