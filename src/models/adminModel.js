import { pool } from '../config/db.js';

// ============================================================
// Workard super admins and what they did
// ============================================================

export async function isAdmin(userId, db = pool) {
  const [rows] = await db.query('SELECT 1 FROM platform_admins WHERE user_id = ?', [userId]);
  return rows.length > 0;
}

export async function findByUserId(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT a.*, u.full_name, u.email, u.locked_at, u.last_login_at
       FROM platform_admins a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ?`,
    [userId]
  );
  return rows[0] || null;
}

export async function list(db = pool) {
  const [rows] = await db.query(
    `SELECT a.user_id, a.created_at, a.setup_token_hash IS NOT NULL AS setup_pending,
            u.full_name, u.email, u.last_login_at, u.locked_at, b.full_name AS added_by_name
       FROM platform_admins a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN users b ON b.id = a.added_by
      ORDER BY a.created_at`
  );
  return rows;
}

export async function add(userId, addedBy, { setupTokenHash = null, setupExpiresAt = null } = {}, db = pool) {
  await db.query(
    `INSERT INTO platform_admins (user_id, added_by, setup_token_hash, setup_expires_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setup_token_hash = VALUES(setup_token_hash), setup_expires_at = VALUES(setup_expires_at)`,
    [userId, addedBy, setupTokenHash, setupExpiresAt]
  );
}

export async function remove(userId, db = pool) {
  await db.query('DELETE FROM platform_admins WHERE user_id = ?', [userId]);
}

export async function count(db = pool) {
  const [[row]] = await db.query('SELECT COUNT(*) AS n FROM platform_admins');
  return Number(row.n);
}

export async function findBySetupToken(tokenHash, db = pool) {
  const [rows] = await db.query(
    `SELECT a.*, u.email, u.full_name FROM platform_admins a JOIN users u ON u.id = a.user_id
      WHERE a.setup_token_hash = ? AND a.setup_expires_at > NOW()`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function clearSetupToken(userId, db = pool) {
  await db.query('UPDATE platform_admins SET setup_token_hash = NULL, setup_expires_at = NULL WHERE user_id = ?', [userId]);
}

// ---------- Admin activity log ----------
export async function log(adminUserId, action, { targetType = null, targetId = null, details = null } = {}, db = pool) {
  if (!adminUserId) return; // e.g. the very first admin, made by the command-line script
  try {
    await db.query(
      'INSERT INTO admin_audit (admin_user_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)',
      [adminUserId, action, targetType, targetId, details ? String(details).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('Admin log failed:', err.message);
  }
}

export async function listLog({ limit = 50, offset = 0 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT l.*, u.full_name AS admin_name,
            CASE l.target_type
              WHEN 'company' THEN (SELECT name FROM organizations WHERE id = l.target_id)
              WHEN 'user' THEN (SELECT email FROM users WHERE id = l.target_id)
              WHEN 'post' THEN (SELECT title FROM blog_posts WHERE id = l.target_id)
              ELSE NULL END AS target_name
       FROM admin_audit l JOIN users u ON u.id = l.admin_user_id
      ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM admin_audit');
  return { rows, total: Number(total) };
}
