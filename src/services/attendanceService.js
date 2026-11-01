import * as attendanceModel from '../models/attendanceModel.js';
import * as branchModel from '../models/branchModel.js';
import * as auditModel from '../models/auditModel.js';
import { getEmployeeOrFail } from './accessService.js';
import { distanceInMetres } from '../utils/geo.js';
import { parseIpList } from '../utils/ip.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString, timeOnDate, addMinutes } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

function requireEmployee(auth) {
  if (!auth.employee) throw new AppError(400, 'Your account is not linked to an employee profile');
  return auth.employee;
}

// ------------------------------------------------------------
// Clock-in checks. Each check is:
//   true  → passed
//   false → failed
//   null  → not set up for this branch (skipped)
// ------------------------------------------------------------
export function checkLocation(branch, { latitude, longitude, accuracy }) {
  if (branch.latitude === null || branch.longitude === null) return { ok: null, distance: null };
  if (latitude === undefined || longitude === undefined || latitude === null) {
    return { ok: false, distance: null, reason: 'Location was not shared' };
  }
  const distance = distanceInMetres(Number(branch.latitude), Number(branch.longitude), latitude, longitude);
  // Phone/laptop GPS can be off a little, so allow up to 100 m of reported inaccuracy
  const allowed = Number(branch.radius_m) + Math.min(Number(accuracy) || 0, 100);
  if (distance <= allowed) return { ok: true, distance };
  const away = distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance} m`;
  return { ok: false, distance, reason: `Outside the office area (${away} away)` };
}

export function checkWifi(branch, ip) {
  const officeIps = parseIpList(branch.office_ips);
  if (!officeIps.length) return { ok: null };
  if (officeIps.includes(ip)) return { ok: true };
  return { ok: false, reason: `Not on the office network (IP ${ip})` };
}

// Combines the two checks using the branch's policy
export function passesPolicy(policy, locationOk, wifiOk) {
  switch (policy) {
    case 'none':
      return true;
    case 'location':
      return locationOk !== false;
    case 'wifi':
      return wifiOk !== false;
    case 'both':
      return locationOk !== false && wifiOk !== false;
    case 'either':
    default:
      if (locationOk === null && wifiOk === null) return true; // nothing set up yet
      return locationOk === true || wifiOk === true;
  }
}

async function getBranchFor(auth, employee) {
  if (!employee.branchId) return null;
  return branchModel.findById(auth.orgId, employee.branchId);
}

// ---------- My day ----------
export async function getToday(auth) {
  const me = requireEmployee(auth);
  const branch = await getBranchFor(auth, me);
  const record = await attendanceModel.findForDay(me.id, toDateString());
  return {
    record,
    branch: branch
      ? {
          name: branch.name,
          policy: branch.clock_in_policy,
          workStart: branch.work_start,
          workEnd: branch.work_end,
          needsLocation: ['location', 'either', 'both'].includes(branch.clock_in_policy) && branch.latitude !== null,
        }
      : null,
  };
}

export async function clockIn(auth, coords, ip) {
  const me = requireEmployee(auth);
  const now = new Date();
  const workDate = toDateString(now);

  if (await attendanceModel.findForDay(me.id, workDate)) throw new AppError(409, 'You have already clocked in today');

  const branch = await getBranchFor(auth, me);
  let location = { ok: null, distance: null };
  let wifi = { ok: null };
  let passed = true;
  let isLate = false;

  if (branch) {
    location = checkLocation(branch, coords);
    wifi = checkWifi(branch, ip);
    passed = passesPolicy(branch.clock_in_policy, location.ok, wifi.ok);
    isLate = now > addMinutes(timeOnDate(branch.work_start, now), Number(branch.grace_minutes));
  }

  const reasons = [location.reason, wifi.reason].filter(Boolean);
  const id = await attendanceModel.createClockIn({
    orgId: auth.orgId,
    employeeId: me.id,
    branchId: branch?.id || null,
    workDate,
    clockInAt: now,
    lat: coords.latitude ?? null,
    lng: coords.longitude ?? null,
    ip,
    distanceM: location.distance,
    locationOk: location.ok === null ? null : Number(location.ok),
    wifiOk: wifi.ok === null ? null : Number(wifi.ok),
    isLate,
    isFlagged: !passed,
    flagReason: passed ? null : reasons.join('; ') || 'Clock-in could not be verified',
  });

  const record = await attendanceModel.findForDay(me.id, workDate);
  return {
    record,
    message: passed
      ? isLate
        ? 'Clocked in — you are late today'
        : 'Clocked in. Have a great day!'
      : `Clocked in, but flagged for review: ${record.flag_reason}`,
    id,
  };
}

export async function clockOut(auth) {
  const me = requireEmployee(auth);
  const record = await attendanceModel.findForDay(me.id, toDateString());
  if (!record) throw new AppError(409, 'You have not clocked in today');
  if (record.clock_out_at) throw new AppError(409, 'You have already clocked out today');

  const now = new Date();
  const minutes = Math.max(0, Math.round((now - new Date(record.clock_in_at.replace(' ', 'T'))) / 60000));
  await attendanceModel.setClockOut(record.id, now, minutes);
  return { record: await attendanceModel.findForDay(me.id, toDateString()), message: 'Clocked out. See you tomorrow!' };
}

// month = "2026-11"
export async function myHistory(auth, month) {
  const me = requireEmployee(auth);
  return historyFor(me.id, month);
}

export async function employeeHistory(auth, employeeId, month) {
  await getEmployeeOrFail(auth, 'attendance.view', employeeId, { allowSelf: true });
  return historyFor(employeeId, month);
}

async function historyFor(employeeId, month) {
  const [y, m] = (month || toDateString().slice(0, 7)).split('-').map(Number);
  const from = toDateString(new Date(y, m - 1, 1));
  const to = toDateString(new Date(y, m, 0));
  const records = await attendanceModel.listForEmployee(employeeId, from, to);
  const summary = {
    daysPresent: records.length,
    daysLate: records.filter((r) => r.is_late).length,
    hoursWorked: Math.round(records.reduce((sum, r) => sum + (r.minutes_worked || 0), 0) / 6) / 10,
  };
  return { records, summary };
}

// ---------- Managers ----------
export async function getRegister(auth, scope, date) {
  const workDate = date || toDateString();
  const rows = await attendanceModel.register(auth.orgId, workDate, scopeCondition(scope, auth.employee));
  const today = toDateString();

  const register = rows.map((r) => {
    let status = 'absent';
    if (r.attendance_id) status = r.review_status === 'pending' ? 'flagged' : r.is_late ? 'late' : 'present';
    else if (r.leave_type) status = 'on_leave';
    else if (workDate > today) status = 'upcoming';
    return { ...r, status };
  });

  const count = (s) => register.filter((r) => r.status === s).length;
  return {
    date: workDate,
    register,
    summary: {
      total: register.length,
      present: count('present') + count('late') + count('flagged'),
      late: count('late'),
      flagged: count('flagged'),
      onLeave: count('on_leave'),
      absent: count('absent'),
    },
  };
}

export async function listFlagged(auth) {
  const scope = auth.permissions['attendance.review'];
  return attendanceModel.listFlaggedPending(auth.orgId, scopeCondition(scope, auth.employee));
}

export async function reviewFlagged(auth, attendanceId, { decision, note }) {
  const record = await attendanceModel.findById(auth.orgId, attendanceId);
  if (!record) throw new AppError(404, 'Attendance record not found');
  if (record.review_status !== 'pending') throw new AppError(409, 'This clock-in has already been reviewed');
  if (auth.employee && auth.employee.id === record.employee_id) throw new AppError(403, 'You cannot review your own clock-in');

  await getEmployeeOrFail(auth, 'attendance.review', record.employee_id);

  await attendanceModel.setReview(record.id, {
    status: decision,
    note,
    reviewedBy: auth.userId,
    reviewedAt: new Date(),
  });
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: `attendance.${decision}`,
    entityType: 'employee',
    entityId: record.employee_id,
    details: `Clock-in on ${record.work_date}${note ? `: ${note}` : ''}`,
  });
  return attendanceModel.findById(auth.orgId, attendanceId);
}
