import { pool } from '../config/db.js';

// Owner-granted, read-only, time-limited access for Workard support
export async function create(orgId, { grantedBy, reason, expiresAt }, db = pool) {
  const [r] = await db.query(
    'INSERT INTO support_grants (organization_id, granted_by, reason, expires_at) VALUES (?, ?, ?, ?)',
    [orgId, grantedBy, reason || null, expiresAt]
  );
  return r.insertId;
}

// The grant that is open right now (not revoked, not expired), if any
export async function findActive(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT g.*, u.full_name AS granted_by_name FROM support_grants g JOIN users u ON u.id = g.granted_by
      WHERE g.organization_id = ? AND g.revoked_at IS NULL AND g.expires_at > NOW()
      ORDER BY g.expires_at DESC LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
}

export async function findById(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM support_grants WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function revokeAll(orgId, db = pool) {
  await db.query('UPDATE support_grants SET revoked_at = NOW() WHERE organization_id = ? AND revoked_at IS NULL AND expires_at > NOW()', [orgId]);
}

export async function list(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT g.id, g.reason, g.expires_at, g.revoked_at, g.created_at, u.full_name AS granted_by_name
       FROM support_grants g JOIN users u ON u.id = g.granted_by
      WHERE g.organization_id = ? ORDER BY g.id DESC LIMIT 20`,
    [orgId]
  );
  return rows;
}
