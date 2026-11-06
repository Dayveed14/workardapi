import { pool } from '../config/db.js';

// The team row (for permission checks) — null if not in this organisation
export async function findTeam(orgId, teamId, db = pool) {
  const [rows] = await db.query('SELECT * FROM teams WHERE organization_id = ? AND id = ?', [orgId, teamId]);
  return rows[0] || null;
}

const TABLE = { branch: 'branches', department: 'departments', team: 'teams' };

// Does this branch / department / team exist in the organisation?
export async function exists(orgId, { type, id }, db = pool) {
  if (type === 'company') return true;
  const [rows] = await db.query(`SELECT id FROM ${TABLE[type]} WHERE organization_id = ? AND id = ?`, [orgId, id]);
  return rows.length > 0;
}

// "Everyone", "Abuja branch", "Sales department", "Field team"
export async function label(orgId, { type, id }, db = pool) {
  if (type === 'company') return 'Everyone';
  const [rows] = await db.query(`SELECT name FROM ${TABLE[type]} WHERE organization_id = ? AND id = ?`, [orgId, id]);
  const name = rows[0]?.name || 'Removed';
  return type === 'branch' ? `${name} branch` : type === 'department' ? `${name} department` : `${name} team`;
}

// SQL snippet that resolves the audience name for a row with audience_type / audience_id (alias a)
export const AUDIENCE_NAME_SQL = (a = 'a') => `CASE ${a}.audience_type
    WHEN 'company' THEN 'Everyone'
    WHEN 'branch' THEN CONCAT((SELECT name FROM branches WHERE id = ${a}.audience_id), ' branch')
    WHEN 'department' THEN CONCAT((SELECT name FROM departments WHERE id = ${a}.audience_id), ' department')
    ELSE CONCAT((SELECT name FROM teams WHERE id = ${a}.audience_id), ' team') END`;

// Active employees in the audience (and a team's supervisor), with their login if they have one
export async function members(orgId, { type, id }, db = pool) {
  const where = {
    company: '1=1',
    branch: 'e.branch_id = ?',
    department: 'e.department_id = ?',
    team: '(e.team_id = ? OR e.id = (SELECT supervisor_employee_id FROM teams WHERE id = ?))',
  }[type];
  const params = type === 'company' ? [] : type === 'team' ? [id, id] : [id];
  const [rows] = await db.query(
    `SELECT e.id, e.user_id, e.first_name, e.last_name, e.photo_url, u.email
       FROM employees e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.organization_id = ? AND e.status = 'active' AND ${where}
      ORDER BY e.first_name, e.last_name`,
    [orgId, ...params]
  );
  return rows;
}

// Groups this person may choose from (all groups; the service filters by permission)
export async function listGroups(orgId, db = pool) {
  const [[branches], [departments], [teams]] = await Promise.all([
    db.query('SELECT id, name FROM branches WHERE organization_id = ? ORDER BY name', [orgId]),
    db.query('SELECT id, name FROM departments WHERE organization_id = ? ORDER BY name', [orgId]),
    db.query('SELECT id, name, department_id, supervisor_employee_id FROM teams WHERE organization_id = ? ORDER BY name', [orgId]),
  ]);
  return { branches, departments, teams };
}
