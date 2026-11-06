import { pool } from '../config/db.js';
import { AUDIENCE_NAME_SQL } from './audienceModel.js';

// Project + its group + progress (cancelled tasks don't count)
const SELECT = `
  SELECT p.*, ${AUDIENCE_NAME_SQL('p')} AS audience_name, u.full_name AS created_by_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'cancelled') AS task_total,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS task_done,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') AS task_in_progress,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('todo','in_progress') AND t.due_date < CURDATE()) AS task_overdue
    FROM projects p JOIN users u ON u.id = p.created_by`;

export async function create(orgId, d, db = pool) {
  const [result] = await db.query(
    `INSERT INTO projects (organization_id, name, description, audience_type, audience_id, color, due_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, d.name, d.description || null, d.audienceType, d.audienceId || null, d.color, d.dueDate || null, d.createdBy]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE p.organization_id = ? AND p.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function listVisible(orgId, visible, { status }, db = pool) {
  const [rows] = await db.query(
    `${SELECT} WHERE p.organization_id = ? AND ${visible.sql} ${status ? 'AND p.status = ?' : ''}
      ORDER BY FIELD(p.status, 'active', 'completed', 'archived'), p.due_date IS NULL, p.due_date, p.name`,
    [orgId, ...visible.params, ...(status ? [status] : [])]
  );
  return rows;
}

export async function update(orgId, id, fields, db = pool) {
  const map = { name: 'name', description: 'description', color: 'color', status: 'status', dueDate: 'due_date' };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(fields[key] === '' ? null : fields[key]);
    }
  }
  if (!sets.length) return;
  await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...values, orgId, id]);
}

// Deleting a project keeps its tasks (they just leave the project)
export async function remove(orgId, id, db = pool) {
  await db.query('UPDATE tasks SET project_id = NULL WHERE organization_id = ? AND project_id = ?', [orgId, id]);
  await db.query('DELETE FROM projects WHERE organization_id = ? AND id = ?', [orgId, id]);
}
