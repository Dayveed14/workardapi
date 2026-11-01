import { withTransaction } from '../config/db.js';
import * as employeePayModel from '../models/employeePayModel.js';
import * as payrollSettingsModel from '../models/payrollSettingsModel.js';
import * as auditModel from '../models/auditModel.js';
import { getEmployeeOrFail } from './accessService.js';
import { calculatePay } from '../utils/payrollCalc.js';
import { settingsForCalc } from './payrollService.js';

// The "Pay" tab on an employee's profile: salary, bank details, pension details,
// extra allowances/deductions, and a preview of a normal month's payslip.
export async function getPay(auth, employeeId) {
  await getEmployeeOrFail(auth, 'payroll.view', employeeId);
  const [pay, items, settings] = await Promise.all([
    employeePayModel.find(employeeId),
    employeePayModel.listItems(employeeId),
    payrollSettingsModel.get(auth.orgId),
  ]);

  const preview = pay
    ? calculatePay(
        {
          basic: Number(pay.basic_kobo),
          housing: Number(pay.housing_kobo),
          transport: Number(pay.transport_kobo),
          allowances: items.filter((i) => i.type === 'allowance').reduce((s, i) => s + Number(i.amount_kobo), 0),
          otherDeductions: items.filter((i) => i.type === 'deduction').reduce((s, i) => s + Number(i.amount_kobo), 0),
          annualRent: Number(pay.annual_rent_kobo),
          nhfOptIn: !!pay.nhf_opt_in,
        },
        settingsForCalc(settings)
      )
    : null;

  // The Paystack recipient code is internal — not needed in the browser
  if (pay) delete pay.paystack_recipient_code;
  return { pay, items, preview };
}

export async function savePay(auth, employeeId, data) {
  const employee = await getEmployeeOrFail(auth, 'payroll.manage', employeeId);
  await withTransaction(async (db) => {
    await employeePayModel.save(auth.orgId, employee.id, data, db);
    await employeePayModel.replaceItems(auth.orgId, employee.id, data.items, db);
  });
  // Salary amounts are NOT written to the activity log — only that it changed
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'employee.pay_updated',
    entityType: 'employee',
    entityId: employee.id,
    details: `${employee.first_name} ${employee.last_name}`,
  });
  return getPay(auth, employeeId);
}
