import { pool } from '../config/db.js';

export async function create(data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO invites (organization_id, employee_id, email, role_id, token_hash, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.orgId, data.employeeId, data.email, data.roleId, data.tokenHash, data.expiresAt, data.createdBy]
  );
  return result.insertId;
}

// Includes organisation and employee names for the "You've been invited" page
export async function findValidByTokenHash(tokenHash, now, db = pool) {
  const [rows] = await db.query(
    `SELECT i.*, o.name AS organization_name, e.first_name, e.last_name
       FROM invites i
       JOIN organizations o ON o.id = i.organization_id
       JOIN employees e ON e.id = i.employee_id
      WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
    [tokenHash, now]
  );
  return rows[0] || null;
}

export async function markAccepted(id, when, db = pool) {
  await db.query('UPDATE invites SET accepted_at = ? WHERE id = ?', [when, id]);
}

// When a new invite is sent, older unused ones stop working
export async function expirePendingForEmployee(employeeId, now, db = pool) {
  await db.query('UPDATE invites SET expires_at = ? WHERE employee_id = ? AND accepted_at IS NULL', [now, employeeId]);
}
