import { pool } from '../config/db.js';

export async function find(employeeId, db = pool) {
  const [rows] = await db.query('SELECT * FROM employee_pay WHERE employee_id = ?', [employeeId]);
  return rows[0] || null;
}

// Creates or updates the employee's pay record.
// If the bank account changes, the saved Paystack recipient is cleared (it points to the old account).
export async function save(orgId, employeeId, data, db = pool) {
  const existing = await find(employeeId, db);
  const bankChanged =
    !existing || existing.account_number !== (data.accountNumber || null) || existing.bank_code !== (data.bankCode || null);

  const values = [
    data.basicKobo,
    data.housingKobo,
    data.transportKobo,
    data.annualRentKobo,
    data.nhfOptIn ? 1 : 0,
    data.bankName || null,
    data.bankCode || null,
    data.accountNumber || null,
    data.accountName || null,
    data.pfaName || null,
    data.pensionPin || null,
    data.taxId || null,
  ];

  if (existing) {
    await db.query(
      `UPDATE employee_pay SET basic_kobo = ?, housing_kobo = ?, transport_kobo = ?, annual_rent_kobo = ?, nhf_opt_in = ?,
              bank_name = ?, bank_code = ?, account_number = ?, account_name = ?, pfa_name = ?, pension_pin = ?, tax_id = ?
              ${bankChanged ? ', paystack_recipient_code = NULL' : ''}
        WHERE employee_id = ?`,
      [...values, employeeId]
    );
  } else {
    await db.query(
      `INSERT INTO employee_pay
         (basic_kobo, housing_kobo, transport_kobo, annual_rent_kobo, nhf_opt_in, bank_name, bank_code,
          account_number, account_name, pfa_name, pension_pin, tax_id, employee_id, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, employeeId, orgId]
    );
  }
}

export async function setRecipientCode(employeeId, code, db = pool) {
  await db.query('UPDATE employee_pay SET paystack_recipient_code = ? WHERE employee_id = ?', [code, employeeId]);
}

// ---------- Extra allowances & deductions ----------
export async function listItems(employeeId, db = pool) {
  const [rows] = await db.query('SELECT * FROM employee_pay_items WHERE employee_id = ? ORDER BY type, id', [employeeId]);
  return rows;
}

export async function replaceItems(orgId, employeeId, items, db = pool) {
  await db.query('DELETE FROM employee_pay_items WHERE employee_id = ?', [employeeId]);
  for (const item of items) {
    await db.query(
      'INSERT INTO employee_pay_items (organization_id, employee_id, type, name, amount_kobo) VALUES (?, ?, ?, ?, ?)',
      [orgId, employeeId, item.type, item.name, item.amountKobo]
    );
  }
}

// Everyone who can be paid this period: active, has a salary, started before the period ends
export async function listPayable(orgId, periodEnd, db = pool) {
  const [rows] = await db.query(
    `SELECT e.id AS employee_id, e.first_name, e.last_name, e.start_date, p.*,
            (SELECT COALESCE(SUM(amount_kobo), 0) FROM employee_pay_items i WHERE i.employee_id = e.id AND i.type = 'allowance') AS allowances_kobo,
            (SELECT COALESCE(SUM(amount_kobo), 0) FROM employee_pay_items i WHERE i.employee_id = e.id AND i.type = 'deduction') AS deductions_kobo
       FROM employees e
       JOIN employee_pay p ON p.employee_id = e.id
      WHERE e.organization_id = ? AND e.status = 'active' AND p.basic_kobo > 0
        AND (e.start_date IS NULL OR e.start_date <= ?)
      ORDER BY e.first_name, e.last_name`,
    [orgId, periodEnd]
  );
  return rows;
}

// Employees with no salary set yet (shown as a warning before running payroll)
export async function listMissingPay(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT e.id, e.first_name, e.last_name FROM employees e
       LEFT JOIN employee_pay p ON p.employee_id = e.id
      WHERE e.organization_id = ? AND e.status = 'active' AND (p.employee_id IS NULL OR p.basic_kobo = 0)
      ORDER BY e.first_name`,
    [orgId]
  );
  return rows;
}
