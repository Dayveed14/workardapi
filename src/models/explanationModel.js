import { pool } from '../config/db.js';

// INSERT IGNORE + attendance_id as the primary key: one answer per clock-in, first one wins
export async function create({ attendanceId, orgId, response, reason, respondedBy }, db = pool) {
  const [result] = await db.query(
    `INSERT IGNORE INTO attendance_explanations (attendance_id, organization_id, response, reason, responded_by)
     VALUES (?, ?, ?, ?, ?)`,
    [attendanceId, orgId, response, reason || null, respondedBy || null]
  );
  return result.affectedRows === 1;
}

export async function find(attendanceId, db = pool) {
  const [rows] = await db.query('SELECT * FROM attendance_explanations WHERE attendance_id = ?', [attendanceId]);
  return rows[0] || null;
}

// Flagged clock-ins still waiting for review whose 24 hours ran out with no answer (all organisations)
export async function listUnanswered(cutoff, db = pool) {
  const [rows] = await db.query(
    `SELECT a.id, a.organization_id, a.employee_id, a.work_date, a.flag_reason, e.first_name, e.last_name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN attendance_explanations x ON x.attendance_id = a.id
      WHERE a.review_status = 'pending' AND x.attendance_id IS NULL AND a.clock_in_at <= ?`,
    [cutoff]
  );
  return rows;
}

// One employee's flagged clock-ins still waiting for their side (clocked in after `since`)
export async function listAwaitingFor(employeeId, since, db = pool) {
  const [rows] = await db.query(
    `SELECT a.id, a.work_date, a.clock_in_at, a.flag_reason, a.review_status
       FROM attendance a
       LEFT JOIN attendance_explanations x ON x.attendance_id = a.id
      WHERE a.employee_id = ? AND a.review_status = 'pending' AND x.attendance_id IS NULL AND a.clock_in_at > ?
      ORDER BY a.clock_in_at`,
    [employeeId, since]
  );
  return rows;
}
