import { addDays } from './dates.js';

// ============================================================
// MEETING REPEATS — one meeting row, many dates ("occurrences").
//
//   repeat_rule   none | daily | weekdays | weekly | monthly
//   repeat_every  every N days / weeks / months (1 = every)
//   repeat_days   weekly only: the days and times, e.g. [{"day":3,"time":"10:00"},{"day":5,"time":"14:30"}]
//                 (0 = Sunday … 6 = Saturday). Empty = the weekday of the first date, at its time.
//   repeat_until  last date (optional)
//   skipped       single dates the organiser cancelled (meeting_skips)
//
// Monthly repeats on the first date's day of the month; in a shorter month
// (e.g. the 31st in April) it falls on the last day of that month.
// ============================================================

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const datePart = (dt) => String(dt).slice(0, 10);
const timePart = (dt) => String(dt).slice(11, 16);
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monday = (date) => addDays(date, -((weekday(date) + 6) % 7));

export function parseDays(value) {
  if (!value) return [];
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list.filter((d) => Number.isInteger(d.day) && d.day >= 0 && d.day <= 6) : [];
  } catch {
    return [];
  }
}

// The weekly days, filling in the old style (no days saved = the first date's weekday)
function weeklyDays(meeting) {
  const days = parseDays(meeting.repeat_days);
  return days.length ? days : [{ day: weekday(datePart(meeting.starts_at)), time: timePart(meeting.starts_at) }];
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12 here
}

function isOn(meeting, date, first) {
  const every = Math.max(1, Number(meeting.repeat_every) || 1);
  const day = weekday(date);
  switch (meeting.repeat_rule) {
    case 'daily':
      return daysBetween(first, date) % every === 0;
    case 'weekdays':
      return day !== 0 && day !== 6;
    case 'weekly': {
      if (!weeklyDays(meeting).some((d) => d.day === day)) return false;
      return (daysBetween(monday(first), monday(date)) / 7) % every === 0;
    }
    case 'monthly': {
      const [fy, fm, fd] = first.split('-').map(Number);
      const [y, m, d] = date.split('-').map(Number);
      const monthsApart = (y - fy) * 12 + (m - fm);
      if (monthsApart % every !== 0) return false;
      return d === Math.min(fd, lastDayOfMonth(y, m));
    }
    default:
      return false;
  }
}

// Every date this meeting happens on, between from and to (skipped dates left out)
export function occurrences(meeting, from, to, skipped = []) {
  const first = datePart(meeting.starts_at);
  const skip = new Set((skipped.length ? skipped : meeting.skipped_dates || []).map(String));
  if (!meeting.repeat_rule || meeting.repeat_rule === 'none') {
    return first >= from && first <= to && !skip.has(first) ? [first] : [];
  }
  const last = [to, meeting.repeat_until ? datePart(meeting.repeat_until) : null].filter(Boolean).sort()[0];
  const dates = [];
  for (let d = first > from ? first : from; d <= last && dates.length < 400; d = addDays(d, 1)) {
    if (isOn(meeting, d, first) && !skip.has(d)) dates.push(d);
  }
  return dates;
}

// The start time on a given date (weekly meetings can have a different time per day)
export function timeOn(meeting, date) {
  if (meeting.repeat_rule === 'weekly') {
    const match = weeklyDays(meeting).find((d) => d.day === weekday(date));
    if (match?.time) return match.time;
  }
  return timePart(meeting.starts_at);
}

const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

// "Every Wednesday 10:00 and Friday 14:30", "Every 2 weeks on Monday", "Monthly on the 15th"
export function describe(meeting) {
  const every = Math.max(1, Number(meeting.repeat_every) || 1);
  switch (meeting.repeat_rule) {
    case 'daily':
      return every === 1 ? 'Every day' : `Every ${every} days`;
    case 'weekdays':
      return 'Every weekday (Mon–Fri)';
    case 'weekly': {
      const days = weeklyDays(meeting).sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7));
      const sameTime = days.every((d) => d.time === days[0].time);
      const list = days.map((d) => `${DAY_NAMES[d.day]}${sameTime ? '' : ` ${d.time}`}`);
      const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
      return every === 1 ? `Every ${joined}` : `Every ${every} weeks on ${joined}`;
    }
    case 'monthly': {
      const day = Number(datePart(meeting.starts_at).slice(8, 10));
      return `${every === 1 ? 'Monthly' : `Every ${every} months`} on the ${ordinal(day)}`;
    }
    default:
      return 'Doesn’t repeat';
  }
}
