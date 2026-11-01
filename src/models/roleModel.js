import { pool } from '../config/db.js';

// permissions is stored as JSON text in the database; turn it back into an object
function toRole(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: !!row.is_system,
    isOwner: !!row.is_owner,
    permissions: JSON.parse(row.permissions || '{}'),
    memberCount: row.member_count !== undefined ? Number(row.member_count) : undefined,
  };
}

export async function create(orgId, { name, description, permissions, isSystem = false, isOwner = false }, db = pool) {
  const [result] = await db.query(
    `INSERT INTO roles (organization_id, name, description, is_system, is_owner, permissions)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orgId, name, description || null, isSystem ? 1 : 0, isOwner ? 1 : 0, JSON.stringify(permissions || {})]
  );
  return result.insertId;
}

export async function listByOrg(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.role_id = r.id AND m.status = 'active') AS member_count
       FROM roles r
      WHERE r.organization_id = ?
      ORDER BY r.is_owner DESC, r.is_system DESC, r.name`,
    [orgId]
  );
  return rows.map(toRole);
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM roles WHERE organization_id = ? AND id = ?', [orgId, id]);
  return toRole(rows[0]);
}

export async function findByName(orgId, name, db = pool) {
  const [rows] = await db.query('SELECT * FROM roles WHERE organization_id = ? AND name = ?', [orgId, name]);
  return toRole(rows[0]);
}

export async function update(orgId, id, { name, description, permissions }, db = pool) {
  await db.query('UPDATE roles SET name = ?, description = ?, permissions = ? WHERE organization_id = ? AND id = ?', [
    name,
    description || null,
    JSON.stringify(permissions || {}),
    orgId,
    id,
  ]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM roles WHERE organization_id = ? AND id = ?', [orgId, id]);
}

export async function countMembers(id, db = pool) {
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM memberships WHERE role_id = ?', [id]);
  return Number(rows[0].total);
}
