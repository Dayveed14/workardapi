import { pool } from '../config/db.js';
import { AUDIENCE_NAME_SQL } from './audienceModel.js';

const LIST_COLUMNS = `r.id, r.audience_type, r.audience_id, r.kind, r.title, r.description, r.file_name, r.file_type, r.file_size,
       r.version, r.created_by, r.created_at, r.updated_at, ${AUDIENCE_NAME_SQL('r')} AS audience_name,
       COALESCE(ub.full_name, cb.full_name) AS updated_by_name`;

export async function create(orgId, d, db = pool) {
  const [result] = await db.query(
    `INSERT INTO resources
       (organization_id, audience_type, audience_id, kind, title, description, body, file_url, file_name, file_type, file_size, file_public_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, d.audienceType, d.audienceId || null, d.kind, d.title, d.description || null, d.body || null, d.fileUrl || null,
      d.fileName || null, d.fileType || null, d.fileSize || null, d.filePublicId || null, d.createdBy]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(
    `SELECT r.*, ${AUDIENCE_NAME_SQL('r')} AS audience_name, cb.full_name AS created_by_name, COALESCE(ub.full_name, cb.full_name) AS updated_by_name
       FROM resources r JOIN users cb ON cb.id = r.created_by LEFT JOIN users ub ON ub.id = r.updated_by
      WHERE r.organization_id = ? AND r.id = ?`,
    [orgId, id]
  );
  return rows[0] || null;
}

export async function listVisible(orgId, visible, { search }, db = pool) {
  const [rows] = await db.query(
    `SELECT ${LIST_COLUMNS}
       FROM resources r JOIN users cb ON cb.id = r.created_by LEFT JOIN users ub ON ub.id = r.updated_by
      WHERE r.organization_id = ? AND ${visible.sql} ${search ? 'AND (r.title LIKE ? OR r.description LIKE ?)' : ''}
      ORDER BY r.updated_at DESC LIMIT 300`,
    [orgId, ...visible.params, ...(search ? [`%${search}%`, `%${search}%`] : [])]
  );
  return rows;
}

// Keep the current content as a version, then save the new content (one transaction, row locked)
export async function saveVersion(resource, savedBy, db) {
  await db.query(
    `INSERT IGNORE INTO resource_versions (resource_id, version, title, body, file_url, file_name, file_public_id, saved_by, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [resource.id, resource.version, resource.title, resource.body, resource.file_url, resource.file_name, resource.file_public_id,
      resource.updated_by || resource.created_by, resource.updated_at]
  );
}

export async function lock(orgId, id, db) {
  const [rows] = await db.query('SELECT * FROM resources WHERE organization_id = ? AND id = ? FOR UPDATE', [orgId, id]);
  return rows[0] || null;
}

export async function update(orgId, id, fields, db = pool) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  await db.query(`UPDATE resources SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...Object.values(fields), orgId, id]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM resources WHERE organization_id = ? AND id = ?', [orgId, id]);
}

export async function versions(resourceId, db = pool) {
  const [rows] = await db.query(
    `SELECT v.id, v.version, v.title, v.file_name, v.saved_at, u.full_name AS saved_by_name
       FROM resource_versions v LEFT JOIN users u ON u.id = v.saved_by
      WHERE v.resource_id = ? ORDER BY v.version DESC`,
    [resourceId]
  );
  return rows;
}

export async function findVersion(resourceId, version, db = pool) {
  const [rows] = await db.query('SELECT * FROM resource_versions WHERE resource_id = ? AND version = ?', [resourceId, version]);
  return rows[0] || null;
}

export async function versionPublicIds(resourceId, db = pool) {
  const [rows] = await db.query('SELECT file_public_id FROM resource_versions WHERE resource_id = ? AND file_public_id IS NOT NULL', [resourceId]);
  return rows.map((r) => r.file_public_id);
}
