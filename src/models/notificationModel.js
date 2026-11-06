import { pool } from '../config/db.js';

// Add one notification for each user (duplicates and empty ids are skipped)
export async function createMany(orgId, userIds, { type, title, body, link, actorUserId }, db = pool) {
  const ids = [...new Set(userIds.filter(Boolean).map(Number))];
  if (!ids.length) return 0;
  const rows = ids.map((userId) => [orgId, userId, type, title.slice(0, 200), body ? String(body).slice(0, 500) : null, link || null, actorUserId || null]);
  await db.query(
    'INSERT INTO notifications (organization_id, user_id, type, title, body, link, actor_user_id) VALUES ?',
    [rows]
  );
  return ids.length;
}

export async function listForUser(orgId, userId, limit = 30, db = pool) {
  const [rows] = await db.query(
    `SELECT n.id, n.type, n.title, n.body, n.link, n.read_at, n.created_at, u.full_name AS actor_name
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_user_id
      WHERE n.organization_id = ? AND n.user_id = ?
      ORDER BY n.id DESC LIMIT ?`,
    [orgId, userId, limit]
  );
  return rows;
}

export async function countUnread(orgId, userId, db = pool) {
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS unread, MAX(id) AS latest FROM notifications WHERE organization_id = ? AND user_id = ? AND read_at IS NULL',
    [orgId, userId]
  );
  return { unread: Number(row.unread), latest: row.latest || null };
}

export async function markRead(orgId, userId, id, db = pool) {
  await db.query('UPDATE notifications SET read_at = NOW() WHERE organization_id = ? AND user_id = ? AND id = ? AND read_at IS NULL', [orgId, userId, id]);
}

export async function markAllRead(orgId, userId, db = pool) {
  await db.query('UPDATE notifications SET read_at = NOW() WHERE organization_id = ? AND user_id = ? AND read_at IS NULL', [orgId, userId]);
}

// The login (user) of each employee, for notifying people by employee id
export async function userIdsOfEmployees(orgId, employeeIds, db = pool) {
  const ids = employeeIds.filter(Boolean);
  if (!ids.length) return [];
  const [rows] = await db.query('SELECT user_id FROM employees WHERE organization_id = ? AND id IN (?) AND user_id IS NOT NULL', [orgId, ids]);
  return rows.map((r) => r.user_id);
}

// Old read notifications are cleared by the daily job after 90 days
export async function deleteOldRead(days = 90, db = pool) {
  const [result] = await db.query('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < NOW() - INTERVAL ? DAY', [days]);
  return result.affectedRows;
}
