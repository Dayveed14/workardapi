import { pool } from '../config/db.js';

// ---------- Leave types ----------
export async function listTypes(orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM leave_types WHERE organization_id = ? ORDER BY name', [orgId]);
  return rows;
}

export async function findTypeById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM leave_types WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function createType(orgId, { name, daysPerYear, isPaid }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO leave_types (organization_id, name, days_per_year, is_paid) VALUES (?, ?, ?, ?)',
    [orgId, name, daysPerYear, isPaid ? 1 : 0]
  );
  return result.insertId;
}

export async function updateType(orgId, id, { name, daysPerYear, isPaid, isActive }, db = pool) {
  await db.query(
    'UPDATE leave_types SET name = ?, days_per_year = ?, is_paid = ?, is_active = ? WHERE organization_id = ? AND id = ?',
    [name, daysPerYear, isPaid ? 1 : 0, isActive ? 1 : 0, orgId, id]
  );
}

// ---------- Leave requests ----------
const SELECT_REQUEST = `
  SELECT lr.*, lt.name AS leave_type, lt.is_paid,
         e.first_name, e.last_name, e.job_title, e.photo_url,
         u.full_name AS reviewed_by_name
    FROM leave_requests lr
    JOIN leave_types lt ON lt.id = lr.leave_type_id
    JOIN employees e ON e.id = lr.employee_id
    LEFT JOIN users u ON u.id = lr.reviewed_by`;

export async function createRequest(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO leave_requests (organization_id, employee_id, leave_type_id, start_date, end_date, days, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orgId, data.employeeId, data.leaveTypeId, data.startDate, data.endDate, data.days, data.reason || null]
  );
  return result.insertId;
}

export async function findRequestById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_REQUEST} WHERE lr.organization_id = ? AND lr.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function listRequests(orgId, scope, { status }, db = pool) {
  const where = ['lr.organization_id = ?', scope.sql];
  const params = [orgId, ...scope.params];
  if (status) {
    where.push('lr.status = ?');
    params.push(status);
  }
  const [rows] = await db.query(`${SELECT_REQUEST} WHERE ${where.join(' AND ')} ORDER BY lr.created_at DESC LIMIT 200`, params);
  return rows;
}

export async function listForEmployee(employeeId, db = pool) {
  const [rows] = await db.query(`${SELECT_REQUEST} WHERE lr.employee_id = ? ORDER BY lr.start_date DESC`, [employeeId]);
  return rows;
}

export async function setStatus(orgId, id, { status, reviewedBy, note, reviewedAt }, db = pool) {
  await db.query(
    `UPDATE leave_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?
      WHERE organization_id = ? AND id = ?`,
    [status, reviewedBy || null, note || null, reviewedAt || null, orgId, id]
  );
}

// Days already taken or waiting for approval this year, per leave type
export async function usedDaysByType(employeeId, year, db = pool) {
  const [rows] = await db.query(
    `SELECT leave_type_id, COALESCE(SUM(days), 0) AS used
       FROM leave_requests
      WHERE employee_id = ? AND status IN ('approved','pending') AND YEAR(start_date) = ?
      GROUP BY leave_type_id`,
    [employeeId, year]
  );
  return Object.fromEntries(rows.map((r) => [r.leave_type_id, Number(r.used)]));
}

// Does a pending/approved request already cover any of these dates?
export async function hasOverlap(employeeId, startDate, endDate, db = pool) {
  const [rows] = await db.query(
    `SELECT id FROM leave_requests
      WHERE employee_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ? LIMIT 1`,
    [employeeId, endDate, startDate]
  );
  return rows.length > 0;
}

export async function countOnLeave(orgId, date, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT lr.employee_id) AS total
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
      WHERE lr.organization_id = ? AND lr.status = 'approved' AND ? BETWEEN lr.start_date AND lr.end_date
        AND e.status = 'active' AND ${scope.sql}`,
    [orgId, date, ...scope.params]
  );
  return Number(rows[0].total);
}

export async function countPending(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
      WHERE lr.organization_id = ? AND lr.status = 'pending' AND ${scope.sql}`,
    [orgId, ...scope.params]
  );
  return Number(rows[0].total);
}

export async function upcoming(orgId, fromDate, scope, limit = 6, db = pool) {
  const [rows] = await db.query(
    `${SELECT_REQUEST}
      WHERE lr.organization_id = ? AND lr.status = 'approved' AND lr.end_date >= ? AND ${scope.sql}
      ORDER BY lr.start_date LIMIT ?`,
    [orgId, fromDate, ...scope.params, limit]
  );
  return rows;
}

// Approved UNPAID leave touching a date range (payroll uses this to reduce pay)
export async function listUnpaidInRange(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT lr.employee_id, lr.start_date, lr.end_date
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.organization_id = ? AND lr.status = 'approved' AND lt.is_paid = 0
        AND lr.start_date <= ? AND lr.end_date >= ?`,
    [orgId, to, from]
  );
  return rows;
}

// Approved leave for one person that overlaps a date range
export async function listApprovedInRange(employeeId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT start_date, end_date FROM leave_requests
      WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`,
    [employeeId, to, from]
  );
  return rows;
}
