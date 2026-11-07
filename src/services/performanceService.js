import * as performanceModel from '../models/performanceModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as attendanceModel from '../models/attendanceModel.js';
import * as leaveModel from '../models/leaveModel.js';
import * as holidayModel from '../models/holidayModel.js';
import { scopeCondition } from '../utils/scope.js';
import { monthAdherence } from '../utils/adherence.js';
import { toDateString, monthRange, addDays } from '../utils/dates.js';

// ============================================================
// TEAM PERFORMANCE — how each person is doing, from a manager's / CEO's angle.
//
// For the chosen month (or the 3 / 6 months up to it), per person:
//   tasks      done on time · done late · overdue (missed and still open)
//   delivery   done on time ÷ (done + overdue)          → "do they deliver on time?"
//   attendance on time ÷ days expected in (as on the Attendance → Monthly page)
//   review     average review score (out of 5), when there is a finished review
//   deals won  leads that became customers (only if they handle customers)
//
//   score = the average of whichever of delivery, attendance and review (as %) exist.
//   Nothing is invented: someone with no tasks and no review is scored on attendance alone.
//   The business owner is left out — this page is their view of everyone else.
// ============================================================

// "2026-11", 3 → ["2026-09", "2026-10", "2026-11"]
function monthsUpTo(month, count) {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(y, m - count + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

function scoreOf(parts) {
  const known = parts.filter((p) => p !== null && p !== undefined);
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

export async function getPerformance(auth, scope, { month, months = 1, departmentId }) {
  const today = toDateString();
  const list = monthsUpTo(month || today.slice(0, 7), months);
  const from = monthRange(list[0]).from;
  const end = monthRange(list[list.length - 1]).to;
  const to = end < today ? end : today;
  const lastMissedDay = addDays(today, -1) < to ? addDays(today, -1) : to; // due today isn't late yet

  const { rows: everyone } = await employeeModel.list(auth.orgId, scopeCondition(scope, auth.employee), {
    status: 'active', departmentId, limit: 2000, offset: 0,
  });
  // The owner is the one looking, not the one being measured (and usually doesn't clock in)
  const people = everyone.filter((p) => !p.role_is_owner);
  const ids = people.map((p) => p.id);

  const [tasks, reviews, deals, records, leaves, holidays] = await Promise.all([
    performanceModel.taskCounts(auth.orgId, ids, from, to, lastMissedDay),
    performanceModel.reviewScores(auth.orgId, ids, from, end),
    performanceModel.dealsWon(auth.orgId, ids, from, to),
    attendanceModel.listForOrgRange(auth.orgId, from, to),
    leaveModel.listApprovedForOrgRange(auth.orgId, from, to),
    holidayModel.datesInRange(auth.orgId, from, to),
  ]);
  const byId = (rows) => new Map(rows.map((r) => [Number(r.employee_id), r]));
  const taskBy = byId(tasks);
  const reviewBy = byId(reviews);
  const dealBy = byId(deals);
  const group = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.employee_id, [...(map.get(r.employee_id) || []), r]);
    return map;
  };
  const recordsBy = group(records);
  const leavesBy = group(leaves);

  const rows = people.map((p) => {
    const t = taskBy.get(p.id) || {};
    const done = Number(t.done || 0);
    const onTime = Number(t.on_time || 0);
    const overdue = Number(t.overdue || 0);

    // Attendance over every month in the range (same rules as the Monthly attendance page)
    const att = { onTime: 0, late: 0, absent: 0, onLeave: 0 };
    for (const m of list) {
      const a = monthAdherence({ month: m, today, startDate: p.start_date, records: recordsBy.get(p.id) || [], leaves: leavesBy.get(p.id) || [], holidays });
      for (const k of Object.keys(att)) att[k] += a[k];
    }
    const expected = att.onTime + att.late + att.absent;

    const review = reviewBy.get(p.id);
    const reviewScore = review ? Math.round(Number(review.score) * 100) / 100 : null;
    const delivery = pct(onTime, done + overdue);
    const attendance = pct(att.onTime, expected);

    return {
      employeeId: p.id,
      staffId: p.staff_id,
      firstName: p.first_name,
      lastName: p.last_name,
      jobTitle: p.job_title,
      photoUrl: p.photo_url,
      departmentName: p.department_name,
      tasks: { done, onTime, late: done - onTime, overdue },
      delivery,
      attendance: { ...att, expected, rate: attendance },
      review: reviewScore,
      dealsWon: Number(dealBy.get(p.id)?.won || 0),
      score: scoreOf([delivery, attendance, reviewScore === null ? null : Math.round((reviewScore / 5) * 100)]),
    };
  });

  // Best first; people with nothing to score yet at the bottom
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.firstName.localeCompare(b.firstName));

  const sum = (fn) => rows.reduce((total, r) => total + fn(r), 0);
  const scored = rows.filter((r) => r.score !== null);
  const reviewed = rows.filter((r) => r.review !== null);
  const team = {
    people: rows.length,
    done: sum((r) => r.tasks.done),
    onTime: sum((r) => r.tasks.onTime),
    late: sum((r) => r.tasks.late),
    overdue: sum((r) => r.tasks.overdue),
    dealsWon: sum((r) => r.dealsWon),
    attendance: pct(sum((r) => r.attendance.onTime), sum((r) => r.attendance.expected)),
    review: reviewed.length ? Math.round((reviewed.reduce((a, r) => a + r.review, 0) / reviewed.length) * 10) / 10 : null,
    score: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null,
  };
  team.delivery = pct(team.onTime, team.done + team.overdue);

  return { from, to, months: list, team, people: rows };
}
