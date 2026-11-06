import { pool } from '../config/db.js';

const SELECT = `
  SELECT m.*, u.full_name AS created_by_name, p.name AS project_name, p.color AS project_color,
         CASE m.audience_type
           WHEN 'people' THEN NULL
           WHEN 'company' THEN 'Everyone'
           WHEN 'branch' THEN CONCAT((SELECT name FROM branches WHERE id = m.audience_id), ' branch')
           WHEN 'department' THEN CONCAT((SELECT name FROM departments WHERE id = m.audience_id), ' department')
           ELSE CONCAT((SELECT name FROM teams WHERE id = m.audience_id), ' team') END AS audience_name
    FROM meetings m
    JOIN users u ON u.id = m.created_by
    LEFT JOIN projects p ON p.id = m.project_id`;

export async function create(orgId, d, db = pool) {
  const [result] = await db.query(
    `INSERT INTO meetings
       (organization_id, title, description, audience_type, audience_id, project_id, starts_at, duration_minutes, repeat_rule, repeat_until, is_standup, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, d.title, d.description || null, d.audienceType, d.audienceId || null, d.projectId || null, d.startsAt, d.durationMinutes,
      d.repeat, d.repeatUntil || null, d.isStandup ? 1 : 0, d.createdBy]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE m.organization_id = ? AND m.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// Meetings that may have an occurrence between from and to (repeating ones started before `to`)
export async function listVisible(orgId, visible, { from, to }, db = pool) {
  const [rows] = await db.query(
    `${SELECT}
      WHERE m.organization_id = ? AND m.cancelled_at IS NULL AND ${visible.sql}
        AND DATE(m.starts_at) <= ?
        AND (m.repeat_rule <> 'none' OR DATE(m.starts_at) >= ?)
        AND (m.repeat_until IS NULL OR m.repeat_until >= ?)
      ORDER BY m.starts_at`,
    [orgId, ...visible.params, to, from, from]
  );
  return rows;
}

export async function update(orgId, id, fields, db = pool) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  if (!sets.length) return;
  await db.query(`UPDATE meetings SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...Object.values(fields), orgId, id]);
}

export async function setInvitees(meetingId, employeeIds, db = pool) {
  await db.query('DELETE FROM meeting_invitees WHERE meeting_id = ?', [meetingId]);
  const ids = [...new Set(employeeIds.map(Number))];
  if (ids.length) await db.query('INSERT INTO meeting_invitees (meeting_id, employee_id) VALUES ?', [ids.map((id) => [meetingId, id])]);
}

export async function invitees(meetingId, db = pool) {
  const [rows] = await db.query(
    `SELECT e.id, e.user_id, e.first_name, e.last_name, e.photo_url, u.email
       FROM meeting_invitees mi JOIN employees e ON e.id = mi.employee_id LEFT JOIN users u ON u.id = e.user_id
      WHERE mi.meeting_id = ? AND e.status = 'active' ORDER BY e.first_name, e.last_name`,
    [meetingId]
  );
  return rows;
}

export async function recordJoin(meetingId, date, userId, db = pool) {
  await db.query('INSERT IGNORE INTO meeting_attendance (meeting_id, occurrence_date, user_id) VALUES (?, ?, ?)', [meetingId, date, userId]);
}

export async function attendance(meetingId, date, db = pool) {
  const [rows] = await db.query('SELECT user_id, joined_at FROM meeting_attendance WHERE meeting_id = ? AND occurrence_date = ?', [meetingId, date]);
  return rows;
}

// Stand-up: each person's tasks (optionally only one project's)
export async function standupTasks(orgId, employeeIds, { projectId, doneSince }, db = pool) {
  if (!employeeIds.length) return [];
  const [rows] = await db.query(
    `SELECT ta.employee_id, t.id, t.title, t.status, t.due_date, t.priority, t.completed_at, p.name AS project_name, p.color AS project_color
       FROM task_assignees ta
       JOIN tasks t ON t.id = ta.task_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.organization_id = ? AND ta.employee_id IN (?) ${projectId ? 'AND t.project_id = ?' : ''}
        AND (t.status IN ('todo','in_progress') OR (t.status = 'done' AND t.completed_at >= ?))
      ORDER BY t.status = 'done' DESC, t.status = 'in_progress' DESC, t.due_date IS NULL, t.due_date`,
    [orgId, employeeIds, ...(projectId ? [projectId] : []), doneSince]
  );
  return rows;
}
