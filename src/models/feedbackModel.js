import { pool } from '../config/db.js';

// Never selects anything that could identify an anonymous sender beyond what's stored (nothing)
const SELECT = `
  SELECT f.id, f.category, f.subject, f.body, f.is_anonymous, f.status, f.created_at, f.updated_at, f.employee_id, f.user_id,
         IF(f.is_anonymous, NULL, CONCAT(e.first_name, ' ', e.last_name)) AS sender_name,
         (SELECT COUNT(*) FROM staff_feedback_replies r WHERE r.feedback_id = f.id) AS reply_count
    FROM staff_feedback f
    LEFT JOIN employees e ON e.id = f.employee_id`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO staff_feedback (organization_id, category, subject, body, is_anonymous, employee_id, user_id, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())`,
    [orgId, data.category, data.subject, data.body, data.isAnonymous ? 1 : 0, data.employeeId || null, data.userId || null, data.tokenHash || null]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE f.organization_id = ? AND f.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function findByTokenHash(orgId, tokenHash, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE f.organization_id = ? AND f.token_hash = ?`, [orgId, tokenHash]);
  return rows[0] || null;
}

export async function list(orgId, { status, userId } = {}, db = pool) {
  const where = ['f.organization_id = ?'];
  const params = [orgId];
  if (status) { where.push('f.status = ?'); params.push(status); }
  if (userId) { where.push('f.user_id = ?'); params.push(userId); }
  const [rows] = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY FIELD(f.status, 'received', 'in_review', 'resolved'), f.id DESC LIMIT 200`,
    params
  );
  return rows;
}

export async function setStatus(orgId, id, status, db = pool) {
  await db.query('UPDATE staff_feedback SET status = ? WHERE organization_id = ? AND id = ?', [status, orgId, id]);
}

export async function addReply(feedbackId, { fromSender, userId, body }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO staff_feedback_replies (feedback_id, from_sender, user_id, body) VALUES (?, ?, ?, ?)',
    [feedbackId, fromSender ? 1 : 0, userId || null, body]
  );
  return result.insertId;
}

export async function replies(feedbackId, db = pool) {
  const [rows] = await db.query(
    `SELECT r.id, r.from_sender, r.body, r.created_at, IF(r.from_sender, NULL, u.full_name) AS author_name
       FROM staff_feedback_replies r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.feedback_id = ? ORDER BY r.id`,
    [feedbackId]
  );
  return rows;
}

// Everyone who replied for the company (to tell them when the sender answers)
export async function replierIds(feedbackId, db = pool) {
  const [rows] = await db.query('SELECT DISTINCT user_id FROM staff_feedback_replies WHERE feedback_id = ? AND from_sender = 0 AND user_id IS NOT NULL', [feedbackId]);
  return rows.map((r) => r.user_id);
}
