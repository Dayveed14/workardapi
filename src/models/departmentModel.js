import { pool } from '../config/db.js';

export async function listByOrg(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS employee_count
       FROM departments d WHERE d.organization_id = ? ORDER BY d.name`,
    [orgId]
  );
  return rows;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM departments WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function create(orgId, { name }, db = pool) {
  const [result] = await db.query('INSERT INTO departments (organization_id, name) VALUES (?, ?)', [orgId, name]);
  return result.insertId;
}

export async function update(orgId, id, { name }, db = pool) {
  await db.query('UPDATE departments SET name = ? WHERE organization_id = ? AND id = ?', [name, orgId, id]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM departments WHERE organization_id = ? AND id = ?', [orgId, id]);
}
