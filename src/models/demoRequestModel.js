import { pool } from '../config/db.js';

export async function create(d, db = pool) {
  const [r] = await db.query(
    'INSERT INTO demo_requests (full_name, email, phone, company, company_size, message) VALUES (?, ?, ?, ?, ?, ?)',
    [d.fullName, d.email, d.phone || null, d.company || null, d.companySize || null, d.message || null]
  );
  return r.insertId;
}

export async function list({ status } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM demo_requests ${status ? 'WHERE status = ?' : ''} ORDER BY FIELD(status, 'new', 'contacted', 'closed'), id DESC LIMIT 500`,
    status ? [status] : []
  );
  return rows;
}

export async function update(id, { status, note }, db = pool) {
  const fields = {};
  if (status) fields.status = status;
  if (note !== undefined) fields.note = note || null;
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE demo_requests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
}

export async function findById(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM demo_requests WHERE id = ?', [id]);
  return rows[0] || null;
}

// A simple guard against someone filling the form many times
export async function countRecentFromEmail(email, db = pool) {
  const [[row]] = await db.query('SELECT COUNT(*) AS n FROM demo_requests WHERE email = ? AND created_at >= NOW() - INTERVAL 1 DAY', [email]);
  return Number(row.n);
}

// ---------- Platform announcements (history) ----------
export async function createAnnouncement(d, db = pool) {
  const [r] = await db.query(
    'INSERT INTO platform_announcements (title, body, audience, emailed, sent_to, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [d.title, d.body, d.audience, d.emailed ? 1 : 0, d.sentTo, d.createdBy]
  );
  return r.insertId;
}

export async function listAnnouncements(db = pool) {
  const [rows] = await db.query(
    `SELECT a.*, u.full_name AS created_by_name FROM platform_announcements a JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT 100`
  );
  return rows;
}
