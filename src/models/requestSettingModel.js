import { pool } from '../config/db.js';

// A company's own loan & advance rules (no row = the defaults in config/requestRules.js)
export async function find(orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM staff_request_settings WHERE organization_id = ?', [orgId]);
  return rows[0] || null;
}

export async function save(orgId, r, userId, db = pool) {
  await db.query(
    `INSERT INTO staff_request_settings
       (organization_id, loans_enabled, loan_max_percent, loan_max_kobo, loan_months, loan_interest_bp,
        advances_enabled, advance_max_percent, advance_months, advance_interest_bp, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       loans_enabled = VALUES(loans_enabled), loan_max_percent = VALUES(loan_max_percent), loan_max_kobo = VALUES(loan_max_kobo),
       loan_months = VALUES(loan_months), loan_interest_bp = VALUES(loan_interest_bp),
       advances_enabled = VALUES(advances_enabled), advance_max_percent = VALUES(advance_max_percent),
       advance_months = VALUES(advance_months), advance_interest_bp = VALUES(advance_interest_bp), updated_by = VALUES(updated_by)`,
    [orgId, r.loansEnabled ? 1 : 0, r.loanMaxPercent, r.loanMaxKobo, r.loanMonths, r.loanInterestBp,
      r.advancesEnabled ? 1 : 0, r.advanceMaxPercent, r.advanceMonths, r.advanceInterestBp, userId]
  );
}

export async function remove(orgId, db = pool) {
  await db.query('DELETE FROM staff_request_settings WHERE organization_id = ?', [orgId]);
}
