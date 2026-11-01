import { pool } from '../config/db.js';

// ---------- Runs ----------
const SELECT_RUN = `
  SELECT r.*, up.full_name AS prepared_by_name, ua.full_name AS approved_by_name,
         (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id AND i.payment_status = 'paid') AS paid_count,
         (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id AND i.payment_status = 'failed') AS failed_count,
         (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id AND i.payment_status = 'processing') AS processing_count
    FROM payroll_runs r
    LEFT JOIN users up ON up.id = r.prepared_by
    LEFT JOIN users ua ON ua.id = r.approved_by`;

export async function create(orgId, { period, preparedBy }, db = pool) {
  const [result] = await db.query('INSERT INTO payroll_runs (organization_id, period, prepared_by) VALUES (?, ?, ?)', [
    orgId,
    period,
    preparedBy,
  ]);
  return result.insertId;
}

export async function findById(orgId, id, { forUpdate = false } = {}, db = pool) {
  const [rows] = await db.query(`${SELECT_RUN} WHERE r.organization_id = ? AND r.id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [
    orgId,
    id,
  ]);
  return rows[0] || null;
}

// The month's live run (not cancelled), if any
export async function findActiveForPeriod(orgId, period, db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM payroll_runs WHERE organization_id = ? AND period = ? AND status <> 'cancelled' LIMIT 1`,
    [orgId, period]
  );
  return rows[0] || null;
}

export async function list(orgId, db = pool) {
  const [rows] = await db.query(`${SELECT_RUN} WHERE r.organization_id = ? ORDER BY r.period DESC, r.id DESC LIMIT 36`, [orgId]);
  return rows;
}

export async function setStatus(id, status, extra = {}, db = pool) {
  const sets = ['status = ?'];
  const values = [status];
  for (const [column, value] of Object.entries(extra)) {
    sets.push(`${column} = ?`);
    values.push(value);
  }
  await db.query(`UPDATE payroll_runs SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
}

// Adds up the items into the run's totals (always from the items — never typed in)
export async function refreshTotals(runId, db = pool) {
  await db.query(
    `UPDATE payroll_runs r JOIN (
        SELECT run_id, COUNT(*) AS n, SUM(gross_kobo) AS gross, SUM(paye_kobo) AS paye,
               SUM(pension_employee_kobo) AS pe, SUM(pension_employer_kobo) AS pr, SUM(nhf_kobo) AS nhf,
               SUM(other_deductions_kobo + one_off_deduction_kobo) AS other, SUM(net_kobo) AS net
          FROM payroll_items WHERE run_id = ? GROUP BY run_id
       ) t ON t.run_id = r.id
       SET r.employee_count = t.n, r.gross_kobo = t.gross, r.paye_kobo = t.paye, r.pension_employee_kobo = t.pe,
           r.pension_employer_kobo = t.pr, r.nhf_kobo = t.nhf, r.other_deductions_kobo = t.other, r.net_kobo = t.net`,
    [runId]
  );
}

// ---------- Items (one payslip per employee) ----------
const ITEM_COLUMNS = [
  'basic_kobo', 'housing_kobo', 'transport_kobo', 'allowances_kobo', 'bonus_kobo', 'proration_kobo', 'gross_kobo',
  'pension_employee_kobo', 'pension_employer_kobo', 'nhf_kobo', 'paye_kobo', 'other_deductions_kobo',
  'one_off_deduction_kobo', 'net_kobo', 'days_payable', 'days_in_period', 'unpaid_leave_days', 'breakdown',
];

function itemValues(r) {
  return [
    r.basic, r.housing, r.transport, r.allowances, r.bonus, r.proration, r.gross, r.pensionEmployee, r.pensionEmployer,
    r.nhf, r.paye, r.otherDeductions, r.oneOffDeduction, r.net, r.daysPayable, r.daysInPeriod, r.unpaidLeaveDays,
    JSON.stringify(r.breakdown || []),
  ];
}

export async function createItem(orgId, runId, employeeId, result, db = pool) {
  await db.query(
    `INSERT INTO payroll_items (organization_id, run_id, employee_id, ${ITEM_COLUMNS.join(', ')})
     VALUES (?, ?, ?, ${ITEM_COLUMNS.map(() => '?').join(', ')})`,
    [orgId, runId, employeeId, ...itemValues(result)]
  );
}

export async function updateItem(itemId, result, db = pool) {
  await db.query(`UPDATE payroll_items SET ${ITEM_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...itemValues(result),
    itemId,
  ]);
}

export async function deleteItems(runId, db = pool) {
  await db.query('DELETE FROM payroll_items WHERE run_id = ?', [runId]);
}

const SELECT_ITEM = `
  SELECT i.*, e.first_name, e.last_name, e.job_title, e.staff_id, e.email,
         d.name AS department_name, p.pfa_name, p.pension_pin, p.tax_id, p.paystack_recipient_code,
         r.period, r.status AS run_status
    FROM payroll_items i
    JOIN payroll_runs r ON r.id = i.run_id
    JOIN employees e ON e.id = i.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN employee_pay p ON p.employee_id = i.employee_id`;

export async function listItems(runId, db = pool) {
  const [rows] = await db.query(`${SELECT_ITEM} WHERE i.run_id = ? ORDER BY e.first_name, e.last_name`, [runId]);
  return rows;
}

export async function findItem(orgId, itemId, db = pool) {
  const [rows] = await db.query(`${SELECT_ITEM} WHERE i.organization_id = ? AND i.id = ?`, [orgId, itemId]);
  return rows[0] || null;
}

export async function findItemByReference(reference, db = pool) {
  const [rows] = await db.query(`${SELECT_ITEM} WHERE i.transfer_reference = ?`, [reference]);
  return rows[0] || null;
}

// Copies bank details onto every item when the run is approved (so later edits can't redirect money)
export async function snapshotBankDetails(runId, db = pool) {
  await db.query(
    `UPDATE payroll_items i JOIN employee_pay p ON p.employee_id = i.employee_id
        SET i.bank_name = p.bank_name, i.bank_code = p.bank_code, i.account_number = p.account_number, i.account_name = p.account_name
      WHERE i.run_id = ?`,
    [runId]
  );
}

export async function setItemPayment(itemId, fields, db = pool) {
  const sets = Object.keys(fields).map((c) => `${c} = ?`);
  await db.query(`UPDATE payroll_items SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(fields), itemId]);
}

// Marks every not-yet-paid item as paid (manual payment: bank upload / cash)
export async function markUnpaidItemsPaid(runId, when, db = pool) {
  await db.query(
    `UPDATE payroll_items SET payment_status = 'paid', paid_at = ?, failure_reason = NULL
      WHERE run_id = ? AND payment_status IN ('pending','failed')`,
    [when, runId]
  );
}

// Payslips for one employee (only from runs that were approved or later)
export async function listForEmployee(employeeId, db = pool) {
  const [rows] = await db.query(
    `${SELECT_ITEM} WHERE i.employee_id = ? AND r.status IN ('approved','processing','paid') ORDER BY r.period DESC`,
    [employeeId]
  );
  return rows;
}
