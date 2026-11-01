import { pool } from '../config/db.js';

const SELECT_RECURRING = `
  SELECT r.*, e.first_name, e.last_name
    FROM recurring_tasks r
    JOIN employees e ON e.id = r.assigned_employee_id`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO recurring_tasks
       (organization_id, title, description, assigned_employee_id, priority, frequency, weekday, month_day, next_run_on, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.title,
      data.description || null,
      data.assignedEmployeeId,
      data.priority,
      data.frequency,
      data.weekday || null,
      data.monthDay || null,
      data.nextRunOn,
      data.createdBy || null,
    ]
  );
  return result.insertId;
}

export async function update(orgId, id, data, db = pool) {
  await db.query(
    `UPDATE recurring_tasks
        SET title = ?, description = ?, assigned_employee_id = ?, priority = ?, frequency = ?,
            weekday = ?, month_day = ?, next_run_on = ?, is_active = ?
      WHERE organization_id = ? AND id = ?`,
    [
      data.title,
      data.description || null,
      data.assignedEmployeeId,
      data.priority,
      data.frequency,
      data.weekday || null,
      data.monthDay || null,
      data.nextRunOn,
      data.isActive ? 1 : 0,
      orgId,
      id,
    ]
  );
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM recurring_tasks WHERE organization_id = ? AND id = ?', [orgId, id]);
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_RECURRING} WHERE r.organization_id = ? AND r.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// `visible` limits to repeating tasks whose assignee ("e") this person can see, or that they created
export async function list(orgId, visible, db = pool) {
  const [rows] = await db.query(
    `${SELECT_RECURRING} WHERE r.organization_id = ? AND ${visible.sql} ORDER BY r.is_active DESC, r.title`,
    [orgId, ...visible.params]
  );
  return rows;
}

// Every active repeating task that is due on or before `today` (all organisations)
export async function listDue(today, db = pool) {
  const [rows] = await db.query(
    `SELECT r.* FROM recurring_tasks r
       JOIN employees e ON e.id = r.assigned_employee_id AND e.status = 'active'
      WHERE r.is_active = 1 AND r.next_run_on <= ?`,
    [today]
  );
  return rows;
}

export async function setNextRun(id, nextRunOn, db = pool) {
  await db.query('UPDATE recurring_tasks SET next_run_on = ? WHERE id = ?', [nextRunOn, id]);
}
