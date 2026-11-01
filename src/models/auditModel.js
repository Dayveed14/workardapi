import { pool } from '../config/db.js';

// Records "who did what". Never throws — a failed log must not break the real action.
export async function log({ orgId, userId, action, entityType, entityId, details }, db = pool) {
  try {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orgId, userId || null, action, entityType || null, entityId || null, details ? String(details).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

export async function list(orgId, { limit = 50, offset = 0 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT l.*, u.full_name AS user_name
       FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.organization_id = ?
      ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [orgId, limit, offset]
  );
  return rows;
}
