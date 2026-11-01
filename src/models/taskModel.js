import { pool } from '../config/db.js';

// Columns a form can set (camelCase → snake_case)
const EDITABLE = {
  title: 'title',
  description: 'description',
  assignedEmployeeId: 'assigned_employee_id',
  dueDate: 'due_date',
  priority: 'priority',
  customerId: 'customer_id',
};

// Task + who it's for + who set it + checklist progress.
// "e" is the ASSIGNED employee — permission scopes are applied to it.
const SELECT_TASK = `
  SELECT t.*,
         e.first_name, e.last_name, e.photo_url, e.job_title, e.user_id AS assignee_user_id,
         u.full_name AS created_by_name,
         c.name AS customer_name,
         (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.task_id = t.id) AS checklist_total,
         (SELECT COUNT(*) FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.is_done = 1) AS checklist_done,
         (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count
    FROM tasks t
    JOIN employees e ON e.id = t.assigned_employee_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN customers c ON c.id = t.customer_id`;

export async function create(orgId, data, db = pool) {
  const columns = ['organization_id', 'created_by', 'recurring_task_id'];
  const values = [orgId, data.createdBy || null, data.recurringTaskId || null];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      columns.push(column);
      values.push(data[key] === '' ? null : data[key]);
    }
  }
  const [result] = await db.query(
    `INSERT INTO tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values
  );
  return result.insertId;
}

// For repeating tasks: INSERT IGNORE + UNIQUE(recurring_task_id, due_date) means
// running the job twice for the same day can never make two tasks.
export async function createFromRecurring(rec, dueDate, db = pool) {
  const [result] = await db.query(
    `INSERT IGNORE INTO tasks (organization_id, title, description, assigned_employee_id, priority, due_date, recurring_task_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.organization_id, rec.title, rec.description, rec.assigned_employee_id, rec.priority, dueDate, rec.id, rec.created_by]
  );
  return result.affectedRows === 1 ? result.insertId : null;
}

export async function update(orgId, id, data, db = pool) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(data[key] === '' ? null : data[key]);
    }
  }
  if (!sets.length) return;
  await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...values, orgId, id]);
}

export async function setStatus(orgId, id, status, db = pool) {
  await db.query(
    `UPDATE tasks SET status = ?, completed_at = ${status === 'done' ? 'NOW()' : 'NULL'} WHERE organization_id = ? AND id = ?`,
    [status, orgId, id]
  );
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM tasks WHERE organization_id = ? AND id = ?', [orgId, id]);
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_TASK} WHERE t.organization_id = ? AND t.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// One task, only if `visible` (built in taskService) allows it
export async function findVisible(orgId, id, visible, db = pool) {
  const [rows] = await db.query(`${SELECT_TASK} WHERE t.organization_id = ? AND t.id = ? AND ${visible.sql}`, [
    orgId,
    id,
    ...visible.params,
  ]);
  return rows[0] || null;
}

// `visible` = the SQL that decides which tasks this person may see (built in taskService)
export async function list(orgId, visible, filters, db = pool) {
  const where = ['t.organization_id = ?', visible.sql];
  const params = [orgId, ...visible.params];

  if (filters.assigneeId) {
    where.push('t.assigned_employee_id = ?');
    params.push(filters.assigneeId);
  }
  if (filters.createdBy) {
    where.push('t.created_by = ?');
    params.push(filters.createdBy);
  }
  if (filters.customerId) {
    where.push('t.customer_id = ?');
    params.push(filters.customerId);
  }
  if (filters.status === 'open') where.push("t.status IN ('todo','in_progress')");
  else if (filters.status) {
    where.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.due === 'overdue') {
    where.push("t.due_date < ? AND t.status IN ('todo','in_progress')");
    params.push(filters.today);
  } else if (filters.due === 'today') {
    where.push('t.due_date = ?');
    params.push(filters.today);
  } else if (filters.due === 'week') {
    where.push('t.due_date BETWEEN ? AND ?');
    params.push(filters.today, filters.weekEnd);
  }
  if (filters.search) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  const whereSql = where.join(' AND ');
  // Open tasks first, then by due date (no date last), then urgent first
  const [rows] = await db.query(
    `${SELECT_TASK} WHERE ${whereSql}
      ORDER BY t.status IN ('done','cancelled'), t.due_date IS NULL, t.due_date,
               FIELD(t.priority, 'urgent','high','normal','low'), t.id DESC
      LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM tasks t JOIN employees e ON e.id = t.assigned_employee_id WHERE ${whereSql}`,
    params
  );
  return { rows, total: Number(countRows[0].total) };
}

// Counts for the dashboard / "My tasks" header
export async function counts(orgId, visible, today, db = pool) {
  const [rows] = await db.query(
    `SELECT
       SUM(t.status IN ('todo','in_progress')) AS open,
       SUM(t.status IN ('todo','in_progress') AND t.due_date < ?) AS overdue,
       SUM(t.status IN ('todo','in_progress') AND t.due_date = ?) AS due_today
     FROM tasks t JOIN employees e ON e.id = t.assigned_employee_id
     WHERE t.organization_id = ? AND ${visible.sql}`,
    [today, today, orgId, ...visible.params]
  );
  const r = rows[0];
  return { open: Number(r.open || 0), overdue: Number(r.overdue || 0), dueToday: Number(r.due_today || 0) };
}

// Numbers used on a performance review
export async function statsForEmployee(employeeId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT
       COUNT(*) AS assigned,
       SUM(status = 'done') AS done,
       SUM(status = 'done' AND (due_date IS NULL OR DATE(completed_at) <= due_date)) AS on_time,
       SUM(status IN ('todo','in_progress') AND due_date <= ?) AS still_open
     FROM tasks
     WHERE assigned_employee_id = ? AND status <> 'cancelled' AND due_date BETWEEN ? AND ?`,
    [to, employeeId, from, to]
  );
  const r = rows[0];
  return {
    assigned: Number(r.assigned || 0),
    done: Number(r.done || 0),
    onTime: Number(r.on_time || 0),
    stillOpen: Number(r.still_open || 0),
  };
}

// Open tasks due today or earlier, per assignee — for the morning email
export async function listDueForDigest(today, db = pool) {
  const [rows] = await db.query(
    `SELECT t.id, t.title, t.due_date, t.priority, t.organization_id,
            e.id AS employee_id, e.first_name, e.email, o.name AS organization_name
       FROM tasks t
       JOIN employees e ON e.id = t.assigned_employee_id AND e.status = 'active'
       JOIN organizations o ON o.id = t.organization_id
      WHERE t.status IN ('todo','in_progress') AND t.due_date <= ?
      ORDER BY e.id, t.due_date`,
    [today]
  );
  return rows;
}

// ---------- Checklist ----------
export async function listChecklist(taskId, db = pool) {
  const [rows] = await db.query('SELECT * FROM task_checklist_items WHERE task_id = ? ORDER BY sort_order, id', [taskId]);
  return rows;
}

export async function addChecklistItem(taskId, text, db = pool) {
  const [result] = await db.query(
    `INSERT INTO task_checklist_items (task_id, text, sort_order)
     SELECT ?, ?, COALESCE(MAX(sort_order), 0) + 1 FROM task_checklist_items WHERE task_id = ?`,
    [taskId, text, taskId]
  );
  return result.insertId;
}

export async function findChecklistItem(itemId, db = pool) {
  const [rows] = await db.query('SELECT * FROM task_checklist_items WHERE id = ?', [itemId]);
  return rows[0] || null;
}

export async function setChecklistDone(itemId, isDone, db = pool) {
  await db.query('UPDATE task_checklist_items SET is_done = ? WHERE id = ?', [isDone ? 1 : 0, itemId]);
}

export async function removeChecklistItem(itemId, db = pool) {
  await db.query('DELETE FROM task_checklist_items WHERE id = ?', [itemId]);
}

// ---------- Comments ----------
export async function listComments(taskId, db = pool) {
  const [rows] = await db.query(
    `SELECT tc.*, u.full_name AS author_name
       FROM task_comments tc LEFT JOIN users u ON u.id = tc.user_id
      WHERE tc.task_id = ? ORDER BY tc.created_at, tc.id`,
    [taskId]
  );
  return rows;
}

export async function addComment(taskId, userId, body, db = pool) {
  const [result] = await db.query('INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)', [taskId, userId, body]);
  return result.insertId;
}

// ---------- Attachments ----------
export async function listAttachments(taskId, db = pool) {
  const [rows] = await db.query('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at', [taskId]);
  return rows;
}

export async function addAttachment(taskId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO task_attachments (task_id, file_name, file_url, public_id, resource_type, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, data.fileName, data.fileUrl, data.publicId, data.resourceType, data.uploadedBy]
  );
  return result.insertId;
}

export async function findAttachment(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM task_attachments WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function removeAttachment(id, db = pool) {
  await db.query('DELETE FROM task_attachments WHERE id = ?', [id]);
}
