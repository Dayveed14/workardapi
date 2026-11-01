import { pool } from '../config/db.js';

export async function findForDay(employeeId, workDate, db = pool) {
  const [rows] = await db.query('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?', [
    employeeId,
    workDate,
  ]);
  return rows[0] || null;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(
    `SELECT a.*, e.branch_id AS employee_branch_id, e.department_id, e.team_id
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.organization_id = ? AND a.id = ?`,
    [orgId, id]
  );
  return rows[0] || null;
}

export async function createClockIn(data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO attendance
       (organization_id, employee_id, branch_id, work_date, clock_in_at, clock_in_lat, clock_in_lng, clock_in_ip,
        distance_m, location_ok, wifi_ok, is_late, is_flagged, flag_reason, review_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orgId,
      data.employeeId,
      data.branchId,
      data.workDate,
      data.clockInAt,
      data.lat,
      data.lng,
      data.ip,
      data.distanceM,
      data.locationOk,
      data.wifiOk,
      data.isLate ? 1 : 0,
      data.isFlagged ? 1 : 0,
      data.flagReason,
      data.isFlagged ? 'pending' : null,
    ]
  );
  return result.insertId;
}

export async function setClockOut(id, clockOutAt, minutesWorked, db = pool) {
  await db.query('UPDATE attendance SET clock_out_at = ?, minutes_worked = ? WHERE id = ?', [
    clockOutAt,
    minutesWorked,
    id,
  ]);
}

export async function setReview(id, { status, note, reviewedBy, reviewedAt }, db = pool) {
  await db.query(
    'UPDATE attendance SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
    [status, note || null, reviewedBy, reviewedAt, id]
  );
}

// Daily register: every active employee in scope, with their attendance for that date (if any)
// and whether they are on approved leave that day.
export async function register(orgId, workDate, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT e.id AS employee_id, e.first_name, e.last_name, e.job_title, e.photo_url,
            b.name AS branch_name, d.name AS department_name,
            a.id AS attendance_id, a.clock_in_at, a.clock_out_at, a.is_late, a.minutes_worked,
            a.is_flagged, a.flag_reason, a.review_status, a.distance_m, a.location_ok, a.wifi_ok, a.clock_in_ip,
            (SELECT lt.name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
              WHERE lr.employee_id = e.id AND lr.status = 'approved' AND ? BETWEEN lr.start_date AND lr.end_date
              LIMIT 1) AS leave_type
       FROM employees e
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
      WHERE e.organization_id = ? AND e.status = 'active' AND ${scope.sql}
      ORDER BY e.first_name, e.last_name`,
    [workDate, workDate, orgId, ...scope.params]
  );
  return rows;
}

export async function listFlaggedPending(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT a.*, e.first_name, e.last_name, b.name AS branch_name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN branches b ON b.id = a.branch_id
      WHERE a.organization_id = ? AND a.review_status = 'pending' AND ${scope.sql}
      ORDER BY a.clock_in_at DESC`,
    [orgId, ...scope.params]
  );
  return rows;
}

export async function listForEmployee(employeeId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC`,
    [employeeId, from, to]
  );
  return rows;
}

// Numbers for the dashboard
export async function todayStats(orgId, workDate, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS present,
            COALESCE(SUM(a.is_late), 0) AS late,
            COALESCE(SUM(a.review_status = 'pending'), 0) AS flagged
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.organization_id = ? AND a.work_date = ? AND e.status = 'active' AND ${scope.sql}`,
    [orgId, workDate, ...scope.params]
  );
  return {
    present: Number(rows[0].present),
    late: Number(rows[0].late),
    flagged: Number(rows[0].flagged),
  };
}

export async function recentClockIns(orgId, workDate, scope, limit = 8, db = pool) {
  const [rows] = await db.query(
    `SELECT a.id, a.clock_in_at, a.clock_out_at, a.is_late, a.review_status,
            e.id AS employee_id, e.first_name, e.last_name, e.photo_url, e.job_title
       FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.organization_id = ? AND a.work_date = ? AND ${scope.sql}
      ORDER BY a.clock_in_at DESC LIMIT ?`,
    [orgId, workDate, ...scope.params, limit]
  );
  return rows;
}

// Attendance numbers for one person over a date range (used on performance reviews)
export async function statsForEmployee(employeeId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS days_present,
            SUM(is_late) AS late,
            SUM(is_flagged) AS flagged,
            ROUND(AVG(minutes_worked)) AS avg_minutes
       FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
    [employeeId, from, to]
  );
  const r = rows[0];
  return {
    daysPresent: Number(r.days_present || 0),
    late: Number(r.late || 0),
    flagged: Number(r.flagged || 0),
    avgMinutesWorked: r.avg_minutes === null ? null : Number(r.avg_minutes),
  };
}
