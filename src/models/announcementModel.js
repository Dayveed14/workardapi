import { pool } from '../config/db.js';
import { AUDIENCE_NAME_SQL } from './audienceModel.js';

const SELECT = `
  SELECT a.*, u.full_name AS author_name, ae.photo_url AS author_photo, ${AUDIENCE_NAME_SQL('a')} AS audience_name,
         (SELECT COUNT(*) FROM announcement_comments c WHERE c.announcement_id = a.id) AS comment_count
    FROM announcements a
    JOIN users u ON u.id = a.author_user_id
    LEFT JOIN employees ae ON ae.user_id = a.author_user_id AND ae.organization_id = a.organization_id`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO announcements
       (organization_id, author_user_id, audience_type, audience_id, title, body, is_pinned, needs_ack, attachment_url, attachment_name, attachment_public_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, data.authorUserId, data.audienceType, data.audienceId || null, data.title, data.body, data.isPinned ? 1 : 0, data.needsAck ? 1 : 0,
      data.attachmentUrl || null, data.attachmentName || null, data.attachmentPublicId || null]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE a.organization_id = ? AND a.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// The feed: pinned first, then newest. `visible` limits it to what the viewer may see.
export async function listVisible(orgId, visible, { before, limit = 20 }, db = pool) {
  const [rows] = await db.query(
    `${SELECT}
      WHERE a.organization_id = ? AND ${visible.sql} ${before ? 'AND a.id < ?' : ''}
      ORDER BY ${before ? '' : 'a.is_pinned DESC,'} a.id DESC LIMIT ?`,
    [orgId, ...visible.params, ...(before ? [before] : []), limit]
  );
  return rows;
}

export async function update(orgId, id, { title, body, isPinned }, db = pool) {
  const sets = [];
  const values = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(title); }
  if (body !== undefined) { sets.push('body = ?'); values.push(body); }
  if (isPinned !== undefined) { sets.push('is_pinned = ?'); values.push(isPinned ? 1 : 0); }
  if (!sets.length) return;
  await db.query(`UPDATE announcements SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...values, orgId, id]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM announcements WHERE organization_id = ? AND id = ?', [orgId, id]);
}

// ---------- Comments ----------
export async function addComment(announcementId, userId, body, db = pool) {
  const [result] = await db.query('INSERT INTO announcement_comments (announcement_id, user_id, body) VALUES (?, ?, ?)', [announcementId, userId, body]);
  return result.insertId;
}

export async function findComment(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM announcement_comments WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function deleteComment(id, db = pool) {
  await db.query('DELETE FROM announcement_comments WHERE id = ?', [id]);
}

export async function commentsFor(announcementIds, db = pool) {
  if (!announcementIds.length) return [];
  const [rows] = await db.query(
    `SELECT c.*, u.full_name AS author_name, e.photo_url AS author_photo
       FROM announcement_comments c
       JOIN users u ON u.id = c.user_id
       JOIN announcements a ON a.id = c.announcement_id
       LEFT JOIN employees e ON e.user_id = c.user_id AND e.organization_id = a.organization_id
      WHERE c.announcement_id IN (?) ORDER BY c.id`,
    [announcementIds]
  );
  return rows;
}

// Everyone who commented (to tell them about replies)
export async function commenterIds(announcementId, db = pool) {
  const [rows] = await db.query('SELECT DISTINCT user_id FROM announcement_comments WHERE announcement_id = ?', [announcementId]);
  return rows.map((r) => r.user_id);
}

// ---------- Seen / "I've read this" ----------
export async function markSeen(announcementIds, userId, db = pool) {
  if (!announcementIds.length) return;
  await db.query('INSERT IGNORE INTO announcement_reads (announcement_id, user_id) VALUES ?', [announcementIds.map((id) => [id, userId])]);
}

export async function acknowledge(announcementId, userId, db = pool) {
  await db.query(
    `INSERT INTO announcement_reads (announcement_id, user_id, acknowledged_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE acknowledged_at = COALESCE(acknowledged_at, NOW())`,
    [announcementId, userId]
  );
}

export async function readsFor(announcementIds, db = pool) {
  if (!announcementIds.length) return [];
  const [rows] = await db.query('SELECT * FROM announcement_reads WHERE announcement_id IN (?)', [announcementIds]);
  return rows;
}
