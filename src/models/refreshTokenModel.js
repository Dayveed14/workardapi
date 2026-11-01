import { pool } from '../config/db.js';

export async function create(data, db = pool) {
  await db.query(
    `INSERT INTO refresh_tokens (user_id, organization_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.userId, data.orgId, data.tokenHash, data.userAgent, data.ip, data.expiresAt]
  );
}

export async function findByHash(tokenHash, db = pool) {
  const [rows] = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = ?', [tokenHash]);
  return rows[0] || null;
}

export async function revoke(id, when, db = pool) {
  await db.query('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [when, id]);
}

export async function revokeByHash(tokenHash, when, db = pool) {
  await db.query('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [
    when,
    tokenHash,
  ]);
}

export async function revokeAllForUser(userId, when, db = pool) {
  await db.query('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [when, userId]);
}
