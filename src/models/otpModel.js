import { pool } from '../config/db.js';

export async function create({ userId, purpose, codeHash, expiresAt, createdAt }, db = pool) {
  await db.query(
    'INSERT INTO otp_codes (user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, purpose, codeHash, expiresAt, createdAt]
  );
}

// The newest unused code for this purpose
export async function findLatest(userId, purpose, db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  return rows[0] || null;
}

export async function addAttempt(id, db = pool) {
  await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [id]);
}

export async function markUsed(id, when, db = pool) {
  await db.query('UPDATE otp_codes SET used_at = ? WHERE id = ?', [when, id]);
}

// Old codes stop working when a new one is sent
export async function invalidateAll(userId, purpose, when, db = pool) {
  await db.query('UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [
    when,
    userId,
    purpose,
  ]);
}
