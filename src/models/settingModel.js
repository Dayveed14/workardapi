import { pool } from '../config/db.js';

// Platform settings the super admin can change (plan prices, trial length). Values are JSON.
export async function all(db = pool) {
  const [rows] = await db.query('SELECT setting_key, value, updated_at FROM platform_settings');
  const out = {};
  for (const r of rows) {
    try {
      out[r.setting_key] = JSON.parse(r.value);
    } catch {
      /* ignore a broken value — the defaults in config/plans.js apply */
    }
  }
  return out;
}

export async function set(key, value, userId, db = pool) {
  await db.query(
    `INSERT INTO platform_settings (setting_key, value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), userId]
  );
}

export async function remove(key, db = pool) {
  await db.query('DELETE FROM platform_settings WHERE setting_key = ?', [key]);
}
