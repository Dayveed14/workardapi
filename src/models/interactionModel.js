import { pool } from '../config/db.js';

const SELECT_INTERACTION = `
  SELECT ci.*, c.name AS customer_name,
         CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
         u.full_name AS created_by_name
    FROM customer_interactions ci
    JOIN customers c ON c.id = ci.customer_id
    LEFT JOIN employees e ON e.id = ci.employee_id
    LEFT JOIN users u ON u.id = ci.created_by`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO customer_interactions
       (organization_id, customer_id, type, subject, details, status, follow_up_on, employee_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.customerId,
      data.type,
      data.subject,
      data.details || null,
      data.status || null,
      data.followUpOn || null,
      data.employeeId || null,
      data.createdBy || null,
    ]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_INTERACTION} WHERE ci.organization_id = ? AND ci.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function listByCustomer(orgId, customerId, db = pool) {
  const [rows] = await db.query(
    `${SELECT_INTERACTION} WHERE ci.organization_id = ? AND ci.customer_id = ? ORDER BY ci.created_at DESC, ci.id DESC`,
    [orgId, customerId]
  );
  return rows;
}

export async function setResolved(id, when, db = pool) {
  await db.query(`UPDATE customer_interactions SET status = 'resolved', resolved_at = ? WHERE id = ?`, [when, id]);
}

export async function setFollowUpDone(id, db = pool) {
  await db.query('UPDATE customer_interactions SET follow_up_done = 1 WHERE id = ?', [id]);
}

// Follow-ups not done yet, due on or before `upTo`.
// Scope applies to the employee handling the follow-up (alias "e").
export async function listFollowUps(orgId, scope, upTo, db = pool) {
  const [rows] = await db.query(
    `${SELECT_INTERACTION}
      WHERE ci.organization_id = ? AND ci.follow_up_on IS NOT NULL AND ci.follow_up_done = 0
        AND ci.follow_up_on <= ? AND ${scope.sql}
      ORDER BY ci.follow_up_on, ci.id`,
    [orgId, upTo, ...scope.params]
  );
  return rows;
}

// Open enquiries & complaints (scope on the handling employee)
export async function listOpenCases(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `${SELECT_INTERACTION}
      WHERE ci.organization_id = ? AND ci.status = 'open' AND ${scope.sql}
      ORDER BY ci.created_at`,
    [orgId, ...scope.params]
  );
  return rows;
}
