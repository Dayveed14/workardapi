// Small date helpers. The server timezone is set in config/env.js (APP_TIMEZONE).

const pad = (n) => String(n).padStart(2, '0');

// "2026-11-02"
export function toDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "2026-11-02 08:05:00"
export function toDateTimeString(date = new Date()) {
  return `${toDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

// Turns "2026-11-02" into a Date at local midnight
export function parseDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Counts Monday–Friday days between two dates, inclusive
export function countWorkingDays(start, end) {
  let count = 0;
  const day = parseDate(start);
  const last = parseDate(end);
  while (day <= last) {
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
    day.setDate(day.getDate() + 1);
  }
  return count;
}

// "08:00:00" + today → Date
export function timeOnDate(time, date = new Date()) {
  const [h, m, s] = time.split(':').map(Number);
  const result = new Date(date);
  result.setHours(h, m, s || 0, 0);
  return result;
}

// "2026-11" → { from: "2026-11-01", to: "2026-11-30" }
export function monthRange(month) {
  const [y, m] = (month || toDateString().slice(0, 7)).split('-').map(Number);
  return { from: toDateString(new Date(y, m - 1, 1)), to: toDateString(new Date(y, m, 0)) };
}

// "2026-11" → ["2026-06", ..., "2026-11"] (the last `count` months)
export function lastMonths(month, count) {
  const [y, m] = month.split('-').map(Number);
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(y, m - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

export function addDays(dateString, days) {
  const d = parseDate(dateString);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

// "2026-11-14" → "14 November 2026"
export function formatDateLong(dateString) {
  return parseDate(dateString).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------- Repeating tasks ----------
// rule = { frequency: 'daily' | 'weekly' | 'monthly', weekday (1 = Mon … 7 = Sun), monthDay (1–31) }
//   daily   → every working day (Monday–Friday)
//   weekly  → the chosen weekday
//   monthly → the chosen day of the month (31 → the last day of shorter months)
// Returns the first date ON or AFTER `fromDate` that matches the rule.
export function nextOccurrence(rule, fromDate) {
  let date = fromDate;
  for (let i = 0; i < 400; i += 1) {
    const d = parseDate(date);
    const weekday = d.getDay() === 0 ? 7 : d.getDay(); // 1 = Monday … 7 = Sunday

    if (rule.frequency === 'daily' && weekday <= 5) return date;
    if (rule.frequency === 'weekly' && weekday === Number(rule.weekday)) return date;
    if (rule.frequency === 'monthly') {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (d.getDate() === Math.min(Number(rule.monthDay), lastDay)) return date;
    }
    date = addDays(date, 1);
  }
  throw new Error('Could not work out the next date for this repeating task');
}

// "2026-11" → months; "2026-Q4" → quarters. Returns { from, to }
export function periodRange(period) {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!quarter) return monthRange(period);
  const y = Number(quarter[1]);
  const q = Number(quarter[2]);
  return { from: toDateString(new Date(y, (q - 1) * 3, 1)), to: toDateString(new Date(y, q * 3, 0)) };
}

// The review period that contains a date: "2026-11" (monthly) or "2026-Q4" (quarterly)
export function periodFor(date, frequency) {
  const [y, m] = date.split('-').map(Number);
  return frequency === 'quarterly' ? `${y}-Q${Math.ceil(m / 3)}` : `${y}-${String(m).padStart(2, '0')}`;
}
