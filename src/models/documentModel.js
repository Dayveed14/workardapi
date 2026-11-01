import { pool } from '../config/db.js';

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO employee_documents
       (organization_id, employee_id, title, category, file_url, public_id, resource_type, file_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.employeeId,
      data.title,
      data.category || 'other',
      data.fileUrl,
      data.publicId,
      data.resourceType,
      data.fileName || null,
      data.mimeType || null,
      data.sizeBytes || null,
      data.uploadedBy || null,
    ]
  );
  return result.insertId;
}

export async function listByEmployee(orgId, employeeId, db = pool) {
  const [rows] = await db.query(
    `SELECT d.*, u.full_name AS uploaded_by_name
       FROM employee_documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.organization_id = ? AND d.employee_id = ?
      ORDER BY d.created_at DESC`,
    [orgId, employeeId]
  );
  return rows;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM employee_documents WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM employee_documents WHERE organization_id = ? AND id = ?', [orgId, id]);
}
