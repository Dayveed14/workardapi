import { pool } from '../config/db.js';

export async function findById(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function findByEmail(email, db = pool) {
  const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

export async function create({ fullName, email, phone, passwordHash, emailVerified = false }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO users (full_name, email, phone, password_hash, email_verified) VALUES (?, ?, ?, ?, ?)',
    [fullName, email, phone || null, passwordHash, emailVerified ? 1 : 0]
  );
  return result.insertId;
}

export async function markEmailVerified(id, db = pool) {
  await db.query('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
}

export async function updatePassword(id, passwordHash, db = pool) {
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

export async function touchLastLogin(id, when, db = pool) {
  await db.query('UPDATE users SET last_login_at = ? WHERE id = ?', [when, id]);
}
