import { pool } from '../config/db.js';

export async function listByOrg(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT t.*, d.name AS department_name,
            CONCAT(s.first_name, ' ', s.last_name) AS supervisor_name,
            (SELECT COUNT(*) FROM employees e WHERE e.team_id = t.id AND e.status = 'active') AS employee_count
       FROM teams t
       LEFT JOIN departments d ON d.id = t.department_id
       LEFT JOIN employees s ON s.id = t.supervisor_employee_id
      WHERE t.organization_id = ?
      ORDER BY t.name`,
    [orgId]
  );
  return rows;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM teams WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function create(orgId, { name, departmentId, supervisorEmployeeId }, db = pool) {
  const [result] = await db.query(
    'INSERT INTO teams (organization_id, name, department_id, supervisor_employee_id) VALUES (?, ?, ?, ?)',
    [orgId, name, departmentId || null, supervisorEmployeeId || null]
  );
  return result.insertId;
}

export async function update(orgId, id, { name, departmentId, supervisorEmployeeId }, db = pool) {
  await db.query(
    'UPDATE teams SET name = ?, department_id = ?, supervisor_employee_id = ? WHERE organization_id = ? AND id = ?',
    [name, departmentId || null, supervisorEmployeeId || null, orgId, id]
  );
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM teams WHERE organization_id = ? AND id = ?', [orgId, id]);
}
