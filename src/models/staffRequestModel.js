import { pool } from '../config/db.js';

// Request + who it's for (alias "e" — permission scopes apply to it) + their line manager
const SELECT = `
  SELECT r.*, e.first_name, e.last_name, e.photo_url, e.manager_id, e.user_id AS employee_user_id,
         d.full_name AS decided_by_name, po.full_name AS paid_out_by_name,
         (r.total_repayable_kobo - r.repaid_kobo) AS balance_kobo
    FROM staff_requests r
    JOIN employees e ON e.id = r.employee_id
    LEFT JOIN users d ON d.id = r.decided_by
    LEFT JOIN users po ON po.id = r.paid_out_by`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO staff_requests
       (organization_id, employee_id, type, amount_kobo, interest_rate_bp, total_repayable_kobo, months, monthly_deduction_kobo, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, data.employeeId, data.type, data.amountKobo, data.interestRateBp, data.totalKobo, data.months, data.monthlyKobo, data.reason || null]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE r.organization_id = ? AND r.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function lock(orgId, id, db) {
  const [rows] = await db.query('SELECT * FROM staff_requests WHERE organization_id = ? AND id = ? FOR UPDATE', [orgId, id]);
  return rows[0] || null;
}

// `where` is extra SQL on r / e (e.g. a scope condition)
export async function list(orgId, where, { status } = {}, db = pool) {
  const [rows] = await db.query(
    `${SELECT} WHERE r.organization_id = ? AND ${where.sql} ${status ? 'AND r.status IN (?)' : ''}
      ORDER BY FIELD(r.status, 'pending', 'approved', 'paid_out', 'repaid', 'rejected', 'cancelled'), r.id DESC LIMIT 200`,
    [orgId, ...where.params, ...(status ? [status] : [])]
  );
  return rows;
}

export async function setStatus(orgId, id, fields, db = pool) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  await db.query(`UPDATE staff_requests SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...Object.values(fields), orgId, id]);
}

// Open loans (asked for, approved or being repaid) — they count towards the loan limit
export async function openLoanTotal(employeeId, db = pool) {
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(amount_kobo), 0) AS total FROM staff_requests
      WHERE employee_id = ? AND type = 'loan' AND status IN ('pending','approved','paid_out')`,
    [employeeId]
  );
  return Number(row.total);
}

export async function hasOpenAdvance(employeeId, db = pool) {
  const [rows] = await db.query(
    "SELECT id FROM staff_requests WHERE employee_id = ? AND type = 'advance' AND status IN ('pending','approved','paid_out') LIMIT 1",
    [employeeId]
  );
  return rows.length > 0;
}

// Money paid out and still being repaid, for every employee in the organisation (payroll uses this)
export async function listRepaying(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT id, employee_id, type, monthly_deduction_kobo, (total_repayable_kobo - repaid_kobo) AS balance_kobo
       FROM staff_requests WHERE organization_id = ? AND status = 'paid_out' AND repaid_kobo < total_repayable_kobo
      ORDER BY id`,
    [orgId]
  );
  return rows;
}

// One payroll's repayment. INSERT IGNORE: the same run never counts twice.
export async function recordRepayment(requestId, runId, amountKobo, db = pool) {
  const [result] = await db.query(
    'INSERT IGNORE INTO staff_request_repayments (request_id, run_id, amount_kobo) VALUES (?, ?, ?)',
    [requestId, runId, amountKobo]
  );
  if (result.affectedRows !== 1) return false;
  await db.query(
    `UPDATE staff_requests
        SET repaid_kobo = LEAST(total_repayable_kobo, repaid_kobo + ?),
            status = IF(repaid_kobo >= total_repayable_kobo, 'repaid', status)
      WHERE id = ?`,
    [amountKobo, requestId]
  );
  return true;
}

export async function repaymentsFor(requestId, db = pool) {
  const [rows] = await db.query(
    `SELECT rp.amount_kobo, rp.created_at, pr.period
       FROM staff_request_repayments rp JOIN payroll_runs pr ON pr.id = rp.run_id
      WHERE rp.request_id = ? ORDER BY rp.id`,
    [requestId]
  );
  return rows;
}
