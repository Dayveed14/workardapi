import { pool } from '../config/db.js';
import * as employeeModel from '../models/employeeModel.js';
import { sendEmail } from './emailService.js';
import { scopeCondition } from '../utils/scope.js';

// Everyone in the organisation whose `permissionKey` scope covers this employee
// (e.g. the team supervisor, HR, the owner) — never the employee themselves.
// Used to tell the right managers about something without spamming the whole company.
export async function reviewersFor(orgId, employeeId, permissionKey) {
  const [rows] = await pool.query(
    `SELECT m.user_id, u.email, u.full_name, r.is_owner, r.permissions,
            e.id AS employee_id, e.branch_id, e.department_id, e.team_id
       FROM memberships m
       JOIN roles r ON r.id = m.role_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN employees e ON e.user_id = m.user_id AND e.organization_id = m.organization_id AND e.status = 'active'
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [orgId]
  );
  const result = [];
  for (const row of rows) {
    if (row.employee_id === Number(employeeId)) continue;
    const scope = row.is_owner ? 'all' : JSON.parse(row.permissions || '{}')[permissionKey];
    if (!scope) continue;
    const me = row.employee_id
      ? { id: row.employee_id, branchId: row.branch_id, departmentId: row.department_id, teamId: row.team_id }
      : null;
    const inScope = await employeeModel.findInScope(orgId, employeeId, scopeCondition(scope, me));
    if (inScope) result.push({ userId: row.user_id, email: row.email, name: row.full_name });
  }
  return result;
}

// Sends one email to each person. A failed email never stops the action that caused it.
export async function emailEach(people, makeEmail) {
  for (const person of people) {
    if (!person.email) continue;
    try {
      await sendEmail({ to: person.email, ...makeEmail(person) });
    } catch (err) {
      console.error('Notification email failed:', err.message);
    }
  }
}
