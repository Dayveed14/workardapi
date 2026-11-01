import { pool } from '../config/db.js';

export async function ensure(orgId, db = pool) {
  await db.query('INSERT IGNORE INTO payroll_settings (organization_id) VALUES (?)', [orgId]);
}

export async function get(orgId, db = pool) {
  await ensure(orgId, db);
  const [rows] = await db.query('SELECT * FROM payroll_settings WHERE organization_id = ?', [orgId]);
  return rows[0];
}

// Locks the organisation's payroll row until the transaction ends.
// Used so two people can't create the same month's payroll at the same time.
export async function lock(orgId, db) {
  await db.query('SELECT organization_id FROM payroll_settings WHERE organization_id = ? FOR UPDATE', [orgId]);
}

export async function update(orgId, data, db = pool) {
  await ensure(orgId, db);
  await db.query(
    `UPDATE payroll_settings SET pay_day = ?, paye_enabled = ?, pension_enabled = ?, pension_employee_rate = ?,
            pension_employer_rate = ?, nhf_enabled = ?, nhf_rate = ?
      WHERE organization_id = ?`,
    [
      data.payDay,
      data.payeEnabled ? 1 : 0,
      data.pensionEnabled ? 1 : 0,
      data.pensionEmployeeRate,
      data.pensionEmployerRate,
      data.nhfEnabled ? 1 : 0,
      data.nhfRate,
      orgId,
    ]
  );
}

export async function setPaystackKey(orgId, { encrypted, last4 }, db = pool) {
  await ensure(orgId, db);
  await db.query('UPDATE payroll_settings SET paystack_secret_enc = ?, paystack_key_last4 = ? WHERE organization_id = ?', [
    encrypted,
    last4,
    orgId,
  ]);
}
