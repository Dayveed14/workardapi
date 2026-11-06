import { pool } from '../config/db.js';

// A new organisation starts unpaid: on a trial (trialEnd) when billing is on,
// or with no end date while Workard is free (its trial starts when billing is switched on)
export async function create(orgId, plan, trialEnd, db = pool) {
  await db.query(
    "INSERT INTO subscriptions (organization_id, plan, status, current_period_end) VALUES (?, ?, 'trial', ?)",
    [orgId, plan, trialEnd || null]
  );
}

export async function find(orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM subscriptions WHERE organization_id = ?', [orgId]);
  return rows[0] || null;
}

// Locks the row while a payment is applied, so two confirmations can't both extend the year
export async function lock(orgId, db) {
  const [rows] = await db.query('SELECT * FROM subscriptions WHERE organization_id = ? FOR UPDATE', [orgId]);
  return rows[0] || null;
}

// A paid period starts (or a bigger plan for the same period). Clears any renewal problem.
export async function activate(orgId, { plan, interval, periodStart, periodEnd }, db = pool) {
  await db.query(
    `UPDATE subscriptions
        SET plan = ?, billing_interval = ?, status = 'active', current_period_start = ?, current_period_end = ?,
            renewal_problem = NULL
      WHERE organization_id = ?`,
    [plan, interval, periodStart, periodEnd, orgId]
  );
}

// ---------- Paystack automatic renewal ----------
export async function saveCard(orgId, { customerCode, authorizationCode }, db = pool) {
  await db.query(
    `UPDATE subscriptions SET paystack_customer_code = COALESCE(?, paystack_customer_code),
            paystack_authorization_code = COALESCE(?, paystack_authorization_code)
      WHERE organization_id = ?`,
    [customerCode, authorizationCode, orgId]
  );
}

export async function saveSubscriptionCode(orgId, { subscriptionCode, emailToken }, db = pool) {
  await db.query(
    'UPDATE subscriptions SET paystack_subscription_code = ?, paystack_email_token = ?, auto_renew = 1 WHERE organization_id = ?',
    [subscriptionCode, emailToken, orgId]
  );
}

export async function findByCustomerCode(customerCode, db = pool) {
  if (!customerCode) return null;
  const [rows] = await db.query('SELECT * FROM subscriptions WHERE paystack_customer_code = ? LIMIT 1', [customerCode]);
  return rows[0] || null;
}

export async function findBySubscriptionCode(code, db = pool) {
  if (!code) return null;
  const [rows] = await db.query('SELECT * FROM subscriptions WHERE paystack_subscription_code = ? LIMIT 1', [code]);
  return rows[0] || null;
}

export async function setAutoRenew(orgId, on, db = pool) {
  await db.query('UPDATE subscriptions SET auto_renew = ? WHERE organization_id = ?', [on ? 1 : 0, orgId]);
}

export async function setRenewalProblem(orgId, problem, db = pool) {
  await db.query('UPDATE subscriptions SET renewal_problem = ? WHERE organization_id = ?', [problem, orgId]);
}

// A plan / interval change that starts with the next period (null, null = none)
export async function setNext(orgId, plan, interval, db = pool) {
  await db.query('UPDATE subscriptions SET next_plan = ?, next_interval = ? WHERE organization_id = ?', [plan, interval, orgId]);
}

// ---------- Paystack plan codes (created once per plan + interval + price) ----------
export async function findPlanCode(plan, interval, amountKobo, db = pool) {
  const [rows] = await db.query(
    'SELECT plan_code FROM billing_plan_codes WHERE plan = ? AND billing_interval = ? AND amount_kobo = ?',
    [plan, interval, amountKobo]
  );
  return rows[0]?.plan_code || null;
}

export async function savePlanCode(plan, interval, amountKobo, planCode, db = pool) {
  await db.query(
    'INSERT IGNORE INTO billing_plan_codes (plan, billing_interval, amount_kobo, plan_code) VALUES (?, ?, ?, ?)',
    [plan, interval, amountKobo, planCode]
  );
}

export async function findPlanByCode(planCode, db = pool) {
  const [rows] = await db.query('SELECT plan, billing_interval AS `interval`, amount_kobo FROM billing_plan_codes WHERE plan_code = ?', [planCode]);
  return rows[0] || null;
}

// Organisations that existed before plans: full access, no end date
export async function ensureLegacy(orgId, db = pool) {
  const [result] = await db.query(
    "INSERT IGNORE INTO subscriptions (organization_id, plan, status, is_legacy) VALUES (?, 'enterprise', 'active', 1)",
    [orgId]
  );
  return result.affectedRows === 1;
}

// ---------- Payments ----------
export async function createPayment(data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO billing_payments (organization_id, reference, plan, kind, billing_interval, amount_kobo, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.orgId, data.reference, data.plan, data.kind, data.interval, data.amountKobo, data.createdBy || null]
  );
  return result.insertId;
}

// An automatic renewal Paystack already charged. INSERT IGNORE on the unique reference:
// the same renewal can never be counted twice. Returns false if it was already recorded.
export async function recordRenewal(data, db = pool) {
  const [result] = await db.query(
    `INSERT IGNORE INTO billing_payments
       (organization_id, reference, plan, kind, billing_interval, amount_kobo, status, period_start, period_end, paid_at)
     VALUES (?, ?, ?, 'auto_renewal', ?, ?, 'paid', ?, ?, NOW())`,
    [data.orgId, data.reference, data.plan, data.interval, data.amountKobo, data.periodStart, data.periodEnd]
  );
  return result.affectedRows === 1;
}

export async function setAuthorizationUrl(id, url, db = pool) {
  await db.query('UPDATE billing_payments SET authorization_url = ? WHERE id = ?', [url, id]);
}

export async function findPaymentByReference(reference, db = pool) {
  const [rows] = await db.query('SELECT * FROM billing_payments WHERE reference = ?', [reference]);
  return rows[0] || null;
}

export async function lockPaymentByReference(reference, db) {
  const [rows] = await db.query('SELECT * FROM billing_payments WHERE reference = ? FOR UPDATE', [reference]);
  return rows[0] || null;
}

export async function markPaymentPaid(id, { periodStart, periodEnd }, db = pool) {
  await db.query(
    "UPDATE billing_payments SET status = 'paid', paid_at = NOW(), period_start = ?, period_end = ? WHERE id = ?",
    [periodStart, periodEnd, id]
  );
}

export async function markPaymentFailed(id, db = pool) {
  await db.query("UPDATE billing_payments SET status = 'failed' WHERE id = ? AND status = 'initiated'", [id]);
}

export async function listPayments(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT bp.*, u.full_name AS paid_by_name
       FROM billing_payments bp LEFT JOIN users u ON u.id = bp.created_by
      WHERE bp.organization_id = ? ORDER BY bp.created_at DESC LIMIT 50`,
    [orgId]
  );
  return rows;
}
