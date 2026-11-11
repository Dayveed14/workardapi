import { pool } from '../config/db.js';

// Columns a form can set (camelCase in JS → snake_case in MySQL)
const EDITABLE = {
  staffId: 'staff_id',
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  gender: 'gender',
  dateOfBirth: 'date_of_birth',
  address: 'address',
  jobTitle: 'job_title',
  employmentType: 'employment_type',
  branchId: 'branch_id',
  departmentId: 'department_id',
  teamId: 'team_id',
  managerId: 'manager_id',
  startDate: 'start_date',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
};

// Shared SELECT with the names of branch, department, team, manager and login role
const SELECT_DETAIL = `
  SELECT e.*,
         b.name AS branch_name, d.name AS department_name, t.name AS team_name,
         CONCAT(mg.first_name, ' ', mg.last_name) AS manager_name,
         r.id AS role_id, r.name AS role_name, r.is_owner AS role_is_owner, m.status AS membership_status,
         (SELECT COUNT(*) FROM invites i WHERE i.employee_id = e.id AND i.accepted_at IS NULL AND i.expires_at > ?) AS pending_invites
    FROM employees e
    LEFT JOIN branches b    ON b.id = e.branch_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN teams t       ON t.id = e.team_id
    LEFT JOIN employees mg  ON mg.id = e.manager_id
    LEFT JOIN memberships m ON m.user_id = e.user_id AND m.organization_id = e.organization_id
    LEFT JOIN roles r       ON r.id = m.role_id`;

export async function create(orgId, data, db = pool) {
  const columns = [];
  const values = [];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      columns.push(column);
      values.push(data[key] === '' ? null : data[key]);
    }
  }
  if (data.userId) {
    columns.push('user_id');
    values.push(data.userId);
  }
  const [result] = await db.query(
    `INSERT INTO employees (organization_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
    [orgId, ...values]
  );
  return result.insertId;
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
  await db.query(`UPDATE employees SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [
    ...values,
    orgId,
    id,
  ]);
}

// Finds one employee, but only if they are inside the given scope condition
export async function findInScope(orgId, id, scope, db = pool) {
  const [rows] = await db.query(`${SELECT_DETAIL} WHERE e.organization_id = ? AND e.id = ? AND ${scope.sql}`, [
    new Date(),
    orgId,
    id,
    ...scope.params,
  ]);
  return rows[0] || null;
}

export async function findById(orgId, id, db = pool) {
  return findInScope(orgId, id, { sql: '1=1', params: [] }, db);
}

export async function findByEmail(orgId, email, db = pool) {
  const [rows] = await db.query('SELECT * FROM employees WHERE organization_id = ? AND email = ?', [orgId, email]);
  return rows[0] || null;
}

export async function list(orgId, scope, { search, branchId, departmentId, teamId, status, limit, offset }, db = pool) {
  const where = ['e.organization_id = ?', scope.sql];
  const params = [orgId, ...scope.params];

  if (search) {
    where.push(`(e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ? OR e.staff_id LIKE ? OR e.job_title LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (branchId) {
    where.push('e.branch_id = ?');
    params.push(branchId);
  }
  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(departmentId);
  }
  if (teamId) {
    where.push('e.team_id = ?');
    params.push(teamId);
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  const whereSql = where.join(' AND ');
  const [rows] = await db.query(
    `${SELECT_DETAIL} WHERE ${whereSql} ORDER BY e.first_name, e.last_name LIMIT ? OFFSET ?`,
    [new Date(), ...params, limit, offset]
  );
  const [countRows] = await db.query(`SELECT COUNT(*) AS total FROM employees e WHERE ${whereSql}`, params);
  return { rows, total: Number(countRows[0].total) };
}

// Small list for dropdowns (e.g. choosing a manager or team supervisor)
export async function listOptions(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT id, first_name, last_name, job_title FROM employees
      WHERE organization_id = ? AND status = 'active' ORDER BY first_name, last_name`,
    [orgId]
  );
  return rows;
}

export async function linkUser(orgId, id, userId, db = pool) {
  await db.query('UPDATE employees SET user_id = ? WHERE organization_id = ? AND id = ?', [userId, orgId, id]);
}

export async function setExited(orgId, id, exitDate, db = pool) {
  await db.query(`UPDATE employees SET status = 'exited', exit_date = ? WHERE organization_id = ? AND id = ?`, [
    exitDate,
    orgId,
    id,
  ]);
}

export async function setPhoto(orgId, id, url, publicId, db = pool) {
  await db.query('UPDATE employees SET photo_url = ?, photo_public_id = ? WHERE organization_id = ? AND id = ?', [
    url,
    publicId,
    orgId,
    id,
  ]);
}

export async function countActive(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total FROM employees e WHERE e.organization_id = ? AND e.status = 'active' AND ${scope.sql}`,
    [orgId, ...scope.params]
  );
  return Number(rows[0].total);
}

export async function countByDepartment(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT COALESCE(d.name, 'No department') AS name, COUNT(*) AS total
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.organization_id = ? AND e.status = 'active' AND ${scope.sql}
      GROUP BY d.name ORDER BY total DESC`,
    [orgId, ...scope.params]
  );
  return rows.map((r) => ({ name: r.name, total: Number(r.total) }));
}

// Active staff who have an email address (Mail → To/Cc suggestions)
export async function emailOptions(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT id, first_name, last_name, email, job_title FROM employees
      WHERE organization_id = ? AND status = 'active' AND email IS NOT NULL AND email <> ''
      ORDER BY first_name, last_name`,
    [orgId]
  );
  return rows;
}
