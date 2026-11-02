import { pool } from '../config/db.js';
import { PERMISSION_KEYS } from '../config/permissions.js';
import { describeSubscription } from '../utils/subscription.js';

export async function create({ userId, orgId, roleId }, db = pool) {
  const [result] = await db.query('INSERT INTO memberships (user_id, organization_id, role_id) VALUES (?, ?, ?)', [
    userId,
    orgId,
    roleId,
  ]);
  return result.insertId;
}

export async function findByUserAndOrg(userId, orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM memberships WHERE user_id = ? AND organization_id = ?', [
    userId,
    orgId,
  ]);
  return rows[0] || null;
}

// All organisations this user can log into
export async function listOrganizationsForUser(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT o.id, o.name, r.name AS role_name
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = ? AND m.status = 'active'
      ORDER BY m.id`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role_name }));
}

export async function updateRole(userId, orgId, roleId, db = pool) {
  await db.query('UPDATE memberships SET role_id = ? WHERE user_id = ? AND organization_id = ?', [
    roleId,
    userId,
    orgId,
  ]);
}

export async function setStatus(userId, orgId, status, db = pool) {
  await db.query('UPDATE memberships SET status = ? WHERE user_id = ? AND organization_id = ?', [
    status,
    userId,
    orgId,
  ]);
}

// Everything the API needs to know about the logged-in person in one query.
// Used by middleware/auth.js on every request, so role changes apply immediately.
export async function findContext(userId, orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT m.user_id, m.organization_id, u.full_name,
            r.id AS role_id, r.name AS role_name, r.is_owner, r.permissions,
            e.id AS employee_id, e.branch_id, e.department_id, e.team_id,
            s.plan AS sub_plan, s.status AS sub_status, s.current_period_end AS sub_period_end, s.is_legacy AS sub_is_legacy
       FROM memberships m
       JOIN roles r ON r.id = m.role_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN subscriptions s ON s.organization_id = m.organization_id
       LEFT JOIN employees e ON e.user_id = m.user_id AND e.organization_id = m.organization_id AND e.status = 'active'
      WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'active'
      LIMIT 1`,
    [userId, orgId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.user_id,
    userName: r.full_name,
    orgId: r.organization_id,
    role: { id: r.role_id, name: r.role_name, isOwner: !!r.is_owner },
    // The Owner always has every permission — including ones added in a later update,
    // even before `npm run db:sync` has been run
    permissions: r.is_owner
      ? Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'all']))
      : JSON.parse(r.permissions || '{}'),
    employee: r.employee_id
      ? { id: r.employee_id, branchId: r.branch_id, departmentId: r.department_id, teamId: r.team_id }
      : null,
    // The organisation's plan: which features it has, its limits, and whether it has paid
    subscription: describeSubscription(
      r.sub_plan
        ? { plan: r.sub_plan, status: r.sub_status, current_period_end: r.sub_period_end, is_legacy: r.sub_is_legacy }
        : null
    ),
  };
}
