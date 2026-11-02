import { pool } from '../config/db.js';

export async function create(orgId, plan, db = pool) {
  await db.query("INSERT INTO subscriptions (organization_id, plan, status) VALUES (?, ?, 'pending_payment')", [orgId, plan]);
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

export async function activate(orgId, { plan, periodStart, periodEnd }, db = pool) {
  await db.query(
    `UPDATE subscriptions
        SET plan = ?, status = 'active', current_period_start = ?, current_period_end = ?
      WHERE organization_id = ?`,
    [plan, periodStart, periodEnd, orgId]
  );
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
    `INSERT INTO billing_payments (organization_id, reference, plan, kind, amount_kobo, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.orgId, data.reference, data.plan, data.kind, data.amountKobo, data.createdBy]
  );
  return result.insertId;
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
