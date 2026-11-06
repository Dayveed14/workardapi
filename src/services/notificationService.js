import { pool } from '../config/db.js';
import * as employeeModel from '../models/employeeModel.js';
import * as notificationModel from '../models/notificationModel.js';
import { sendEmail } from './emailService.js';
import { scopeCondition } from '../utils/scope.js';

// ============================================================
// NOTIFICATIONS — the bell in the top bar (and the emails that go with some of them)
//   notify(orgId, userIds, { type, title, body, link, actorUserId })
// The person who caused it is never notified about their own action.
// A failed notification never stops the action that caused it.
// ============================================================
export async function notify(orgId, userIds, { actorUserId, ...note }) {
  try {
    const recipients = userIds.filter((id) => id && Number(id) !== Number(actorUserId));
    return await notificationModel.createMany(orgId, recipients, { ...note, actorUserId });
  } catch (err) {
    console.error('Notification failed:', err.message);
    return 0;
  }
}

// Same, addressed by employee id (e.g. "the person this task is assigned to")
export async function notifyEmployees(orgId, employeeIds, note) {
  return notify(orgId, await notificationModel.userIdsOfEmployees(orgId, employeeIds), note);
}

// ---------- What the bell shows ----------
export async function listMine(auth) {
  const [items, counts] = await Promise.all([
    notificationModel.listForUser(auth.orgId, auth.userId),
    notificationModel.countUnread(auth.orgId, auth.userId),
  ]);
  return { items, ...counts };
}

export const countMine = (auth) => notificationModel.countUnread(auth.orgId, auth.userId);
export const markRead = (auth, id) => notificationModel.markRead(auth.orgId, auth.userId, id);
export const markAllRead = (auth) => notificationModel.markAllRead(auth.orgId, auth.userId);

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
