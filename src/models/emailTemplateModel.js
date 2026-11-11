import { pool } from '../config/db.js';

// Saved emails. A template is personal (only its creator sees it) or shared with the company.

export async function listVisible(orgId, userId, db = pool) {
  const [rows] = await db.query(
    `SELECT t.*, u.full_name AS created_by_name FROM email_templates t JOIN users u ON u.id = t.created_by
      WHERE t.organization_id = ? AND (t.is_shared = 1 OR t.created_by = ?)
      ORDER BY t.name`,
    [orgId, userId]
  );
  return rows;
}

export async function findVisible(orgId, id, userId, db = pool) {
  const [rows] = await db.query(
    'SELECT * FROM email_templates WHERE organization_id = ? AND id = ? AND (is_shared = 1 OR created_by = ?)',
    [orgId, id, userId]
  );
  return rows[0] || null;
}

export async function create(orgId, userId, t, db = pool) {
  const [result] = await db.query(
    'INSERT INTO email_templates (organization_id, created_by, name, subject, body_html, is_shared) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, userId, t.name, t.subject, t.bodyHtml, t.isShared ? 1 : 0]
  );
  return result.insertId;
}

export async function update(orgId, id, t, db = pool) {
  await db.query('UPDATE email_templates SET name = ?, subject = ?, body_html = ?, is_shared = ? WHERE organization_id = ? AND id = ?', [
    t.name,
    t.subject,
    t.bodyHtml,
    t.isShared ? 1 : 0,
    orgId,
    id,
  ]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM email_templates WHERE organization_id = ? AND id = ?', [orgId, id]);
}
