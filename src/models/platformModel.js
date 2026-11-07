import { pool } from '../config/db.js';

// ============================================================
// What the Workard super admin sees across ALL companies.
// Counts and account details only — never a company's own records
// (salaries, payslips, invoices, customers, feedback …).
// ============================================================

// The company's owner (the first person with the Owner role)
const OWNER_ID = `(SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
                    WHERE m.organization_id = o.id AND r.is_owner = 1 ORDER BY m.id LIMIT 1)`;

const COMPANY_SELECT = `
  SELECT o.id, o.name, o.industry, o.size, o.created_at, o.suspended_at, o.suspended_reason,
         s.plan, s.status AS sub_status, s.current_period_start, s.current_period_end, s.is_legacy, s.billing_interval,
         s.auto_renew, s.renewal_problem, s.next_plan, s.next_interval, s.created_at AS sub_created_at,
         s.paystack_subscription_code IS NOT NULL AS has_card,
         ou.id AS owner_user_id, ou.full_name AS owner_name, ou.email AS owner_email, ou.phone AS owner_phone,
         (SELECT COUNT(*) FROM employees e WHERE e.organization_id = o.id AND e.status = 'active') AS employees,
         (SELECT MAX(u.last_login_at) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id) AS last_active
    FROM organizations o
    LEFT JOIN subscriptions s ON s.organization_id = o.id
    LEFT JOIN users ou ON ou.id = ${OWNER_ID}`;

export async function listCompanies({ search } = {}, db = pool) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(o.name LIKE ? OR ou.email LIKE ? OR ou.full_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const [rows] = await db.query(
    `${COMPANY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT 5000`,
    params
  );
  return rows;
}

export async function findCompany(id, db = pool) {
  const [rows] = await db.query(`${COMPANY_SELECT} WHERE o.id = ?`, [id]);
  return rows[0] || null;
}

// How much of Workard a company uses (numbers only)
export async function usage(orgId, db = pool) {
  const count = async (sql) => Number((await db.query(sql, [orgId]))[0][0].n);
  const [branches, departments, customers, invoices, payrollRuns, tasks, meetings, announcements, logins30] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM branches WHERE organization_id = ?'),
    count('SELECT COUNT(*) AS n FROM departments WHERE organization_id = ?'),
    count('SELECT COUNT(*) AS n FROM customers WHERE organization_id = ?'),
    count('SELECT COUNT(*) AS n FROM invoices WHERE organization_id = ?'),
    count("SELECT COUNT(*) AS n FROM payroll_runs WHERE organization_id = ? AND status <> 'cancelled'"),
    count('SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ?'),
    count('SELECT COUNT(*) AS n FROM meetings WHERE organization_id = ? AND cancelled_at IS NULL'),
    count('SELECT COUNT(*) AS n FROM announcements WHERE organization_id = ?'),
    count(`SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = ? AND u.last_login_at >= NOW() - INTERVAL 30 DAY`),
  ]);
  return { branches, departments, customers, invoices, payrollRuns, tasks, meetings, announcements, activeUsers30: logins30 };
}

export async function setSuspended(orgId, reason, db = pool) {
  await db.query('UPDATE organizations SET suspended_at = ?, suspended_reason = ? WHERE id = ?', [reason ? new Date() : null, reason || null, orgId]);
}

export async function findSuspension(orgId, db = pool) {
  const [rows] = await db.query('SELECT suspended_at, suspended_reason FROM organizations WHERE id = ?', [orgId]);
  return rows[0]?.suspended_at ? rows[0] : null;
}

// Subscription changes made by an admin (no payment involved)
export async function updateSubscription(orgId, fields, db = pool) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE organization_id = ?`, [...Object.values(fields), orgId]);
}

// Owners of every company (for platform announcements)
export async function owners(db = pool) {
  const [rows] = await db.query(
    `SELECT o.id AS organization_id, o.name AS organization_name, ou.id AS user_id, ou.full_name, ou.email,
            s.plan, s.status AS sub_status, s.current_period_end, s.is_legacy, s.created_at AS sub_created_at
       FROM organizations o
       LEFT JOIN subscriptions s ON s.organization_id = o.id
       JOIN users ou ON ou.id = ${OWNER_ID}
      WHERE o.suspended_at IS NULL`
  );
  return rows;
}

// ---------- Users ----------
export async function listUsers({ search, limit = 50 } = {}, db = pool) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(u.email LIKE ? OR u.full_name LIKE ? OR u.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const [rows] = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.email_verified, u.last_login_at, u.locked_at, u.created_at,
            EXISTS (SELECT 1 FROM platform_admins a WHERE a.user_id = u.id) AS is_admin,
            GROUP_CONCAT(CONCAT(o.id, '|', o.name, '|', r.name, '|', m.status) ORDER BY m.id SEPARATOR ';;') AS memberships
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN roles r ON r.id = m.role_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ?`,
    [...params, limit]
  );
  return rows.map((u) => ({
    ...u,
    memberships: u.memberships
      ? u.memberships.split(';;').map((m) => {
          const [orgId, orgName, role, status] = m.split('|');
          return { orgId: Number(orgId), orgName, role, status };
        })
      : [],
  }));
}

export async function findUser(id, db = pool) {
  const [rows] = await db.query('SELECT id, full_name, email, locked_at FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function setLocked(userId, locked, db = pool) {
  await db.query('UPDATE users SET locked_at = ? WHERE id = ?', [locked ? new Date() : null, userId]);
}

// ---------- Payments to Workard ----------
export async function listPayments({ status, orgId, limit = 100, offset = 0 } = {}, db = pool) {
  const where = [];
  const params = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (orgId) { where.push('p.organization_id = ?'); params.push(orgId); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query(
    `SELECT p.id, p.organization_id, o.name AS organization_name, p.reference, p.plan, p.kind, p.billing_interval,
            p.amount_kobo, p.status, p.period_start, p.period_end, p.paid_at, p.created_at
       FROM billing_payments p JOIN organizations o ON o.id = p.organization_id
       ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[sum]] = await db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount_kobo END), 0) AS paid_kobo FROM billing_payments p ${w}`,
    params
  );
  return { rows, total: Number(sum.total), paidKobo: Number(sum.paid_kobo) };
}

// ---------- Overview numbers ----------
export async function signupsByWeek(weeks = 12, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_SUB(DATE(created_at), INTERVAL WEEKDAY(created_at) DAY) AS week, COUNT(*) AS n
       FROM organizations
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
      GROUP BY week ORDER BY week`,
    [weeks]
  );
  return rows.map((r) => ({ week: String(r.week).slice(0, 10), count: Number(r.n) }));
}

export async function revenueByMonth(months = 12, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS month, SUM(amount_kobo) AS kobo, COUNT(*) AS n
       FROM billing_payments
      WHERE status = 'paid' AND paid_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL ? MONTH)
      GROUP BY month ORDER BY month`,
    [months - 1]
  );
  return rows.map((r) => ({ month: r.month, kobo: Number(r.kobo), payments: Number(r.n) }));
}

export async function failedPaymentsSince(days = 30, db = pool) {
  const [[row]] = await db.query("SELECT COUNT(*) AS n FROM billing_payments WHERE status = 'failed' AND created_at >= NOW() - INTERVAL ? DAY", [days]);
  return Number(row.n);
}

export async function totals(db = pool) {
  const [[row]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM organizations) AS companies,
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM employees WHERE status = 'active') AS employees,
            (SELECT COUNT(*) FROM users WHERE last_login_at >= NOW() - INTERVAL 7 DAY) AS active7,
            (SELECT COUNT(*) FROM demo_requests WHERE status = 'new') AS newDemos`
  );
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}
