// ============================================================
// PAYROLL RUNS
//
//   draft ──approve──► approved ──pay──► paid
//     │                   │        └──(Paystack)──► processing ──► paid
//     └──────cancel───────┘
//
// - DRAFT: numbers can be recalculated and one-off bonus/deductions added.
// - APPROVE: maker–checker. The person who prepared the run can't approve it
//   (unless they are the Owner — so a one-person business can still run payroll).
//   Bank details are copied onto each payslip at this moment.
// - PAY: either "mark as paid" (bank bulk-upload / cash) or Paystack transfers
//   (see payoutService.js).
// - When fully paid: salary + employer pension are recorded ONCE as expenses
//   in Finance, so the profit report stays accurate.
// ============================================================
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import * as payrollRunModel from '../models/payrollRunModel.js';
import * as payrollSettingsModel from '../models/payrollSettingsModel.js';
import * as employeePayModel from '../models/employeePayModel.js';
import * as leaveModel from '../models/leaveModel.js';
import * as financeModel from '../models/financeModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { sendEmail, payslipEmail } from './emailService.js';
import { calculatePay } from '../utils/payrollCalc.js';
import { formatNaira } from '../utils/money.js';
import { monthRange, countWorkingDays, toDateString } from '../utils/dates.js';
import { encrypt } from '../utils/encryption.js';
import * as paystackService from './paystackService.js';
import { repaymentLines, recordRepaymentsForRun } from './staffRequestService.js';
import AppError from '../utils/AppError.js';

// ---------- Settings ----------
export function settingsForCalc(s) {
  return {
    payeEnabled: !!s.paye_enabled,
    pensionEnabled: !!s.pension_enabled,
    pensionEmployeeRate: Number(s.pension_employee_rate),
    pensionEmployerRate: Number(s.pension_employer_rate),
    nhfEnabled: !!s.nhf_enabled,
    nhfRate: Number(s.nhf_rate),
  };
}

// What the settings page sees (never the secret key itself)
export async function getSettings(orgId) {
  const s = await payrollSettingsModel.get(orgId);
  return {
    payDay: s.pay_day,
    ...settingsForCalc(s),
    paystackConnected: Boolean(s.paystack_secret_enc),
    paystackKeyLast4: s.paystack_key_last4,
    webhookUrl: `${env.apiPublicUrl}/api/webhooks/paystack/${orgId}`,
  };
}

export async function updateSettings(auth, data) {
  await payrollSettingsModel.update(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'payroll_settings.updated' });
  return getSettings(auth.orgId);
}

// Saves the business's Paystack secret key — encrypted — after checking it works
export async function connectPaystack(auth, { secretKey }) {
  await paystackService.listBanks(secretKey); // throws if the key is wrong
  await payrollSettingsModel.setPaystackKey(auth.orgId, { encrypted: encrypt(secretKey), last4: secretKey.slice(-4) });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'paystack.connected', details: `key ending ${secretKey.slice(-4)}` });
  return getSettings(auth.orgId);
}

export async function disconnectPaystack(auth) {
  await payrollSettingsModel.setPaystackKey(auth.orgId, { encrypted: null, last4: null });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'paystack.disconnected' });
  return getSettings(auth.orgId);
}

// ---------- Working out one payslip ----------
// Working days (Mon–Fri) this employee is paid for: from their start date, minus unpaid leave
function payableDays(row, from, to, unpaidLeave) {
  const daysInPeriod = countWorkingDays(from, to);
  const start = row.start_date && row.start_date > from ? row.start_date : from;
  let unpaidLeaveDays = 0;
  for (const leave of unpaidLeave.filter((l) => l.employee_id === row.employee_id)) {
    const s = leave.start_date > start ? leave.start_date : start;
    const e = leave.end_date < to ? leave.end_date : to;
    if (s <= e) unpaidLeaveDays += countWorkingDays(s, e);
  }
  const daysPayable = Math.max(0, countWorkingDays(start, to) - unpaidLeaveDays);
  return { daysInPeriod, daysPayable, unpaidLeaveDays };
}

// repayments: this month's loan / advance repayments for this employee (payslip lines)
function computeItem(row, settings, days, adjustments = {}, repayments = []) {
  const repaying = repayments.reduce((sum, l) => sum + l.amountKobo, 0);
  const result = calculatePay(
    {
      basic: Number(row.basic_kobo),
      housing: Number(row.housing_kobo),
      transport: Number(row.transport_kobo),
      allowances: Number(row.allowances_kobo),
      otherDeductions: Number(row.deductions_kobo) + repaying,
      annualRent: Number(row.annual_rent_kobo),
      nhfOptIn: !!row.nhf_opt_in,
    },
    settings,
    {
      bonus: adjustments.bonus || 0,
      oneOffDeduction: adjustments.oneOffDeduction || 0,
      payableFraction: days.daysInPeriod ? days.daysPayable / days.daysInPeriod : 0,
    }
  );
  return { ...result, ...days, breakdown: repayments };
}

// Builds every payslip for the run. Keeps any bonus / one-off deduction already entered.
async function buildItems(orgId, run, db) {
  const settings = settingsForCalc(await payrollSettingsModel.get(orgId, db));
  const { from, to } = monthRange(run.period);
  const [rows, unpaidLeave, existing, repayments] = await Promise.all([
    employeePayModel.listPayable(orgId, to, db),
    leaveModel.listUnpaidInRange(orgId, from, to, db),
    payrollRunModel.listItems(run.id, db),
    repaymentLines(orgId, db), // salary advances & staff loans being repaid
  ]);

  const kept = Object.fromEntries(
    existing.map((i) => [i.employee_id, { bonus: Number(i.bonus_kobo), oneOffDeduction: Number(i.one_off_deduction_kobo) }])
  );

  await payrollRunModel.deleteItems(run.id, db);
  for (const row of rows) {
    const days = payableDays(row, from, to, unpaidLeave);
    await payrollRunModel.createItem(orgId, run.id, row.employee_id, computeItem(row, settings, days, kept[row.employee_id], repayments[row.employee_id]), db);
  }
  await payrollRunModel.refreshTotals(run.id, db);
}

// ---------- Runs ----------
export async function listRuns(orgId) {
  const [runs, settings, missingPay] = await Promise.all([
    payrollRunModel.list(orgId),
    getSettings(orgId),
    employeePayModel.listMissingPay(orgId),
  ]);
  return { runs, settings, missingPay };
}

async function getRunOrFail(orgId, id, opts, db) {
  const run = await payrollRunModel.findById(orgId, id, opts, db);
  if (!run) throw new AppError(404, 'Payroll run not found');
  return run;
}

export async function getRun(auth, id) {
  const run = await getRunOrFail(auth.orgId, id);
  const [items, missingPay, settings] = await Promise.all([
    payrollRunModel.listItems(run.id),
    employeePayModel.listMissingPay(auth.orgId),
    getSettings(auth.orgId),
  ]);
  return { ...run, items, missingPay, settings, canApprove: canApprove(auth, run) };
}

function canApprove(auth, run) {
  return Boolean(auth.permissions['payroll.approve']) && (run.prepared_by !== auth.userId || auth.role.isOwner);
}

export async function createRun(auth, { period }) {
  const id = await withTransaction(async (db) => {
    // Lock this organisation's payroll so two people can't create the same month twice
    await payrollSettingsModel.ensure(auth.orgId, db);
    await payrollSettingsModel.lock(auth.orgId, db);

    if (await payrollRunModel.findActiveForPeriod(auth.orgId, period, db)) {
      throw new AppError(409, 'There is already a payroll for this month. Open it, or cancel it first.');
    }
    const runId = await payrollRunModel.create(auth.orgId, { period, preparedBy: auth.userId }, db);
    await buildItems(auth.orgId, { id: runId, period }, db);
    return runId;
  });

  const run = await getRunOrFail(auth.orgId, id);
  if (!run.employee_count) {
    await payrollRunModel.setStatus(id, 'cancelled');
    throw new AppError(422, 'No one to pay yet. Set each employee’s salary on their profile (Pay tab) first.');
  }
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'payroll.created', entityType: 'payroll', entityId: id, details: period });
  return getRun(auth, id);
}

// Picks up salary changes, new joiners and unpaid leave (draft only)
export async function recalculate(auth, id) {
  await withTransaction(async (db) => {
    const run = await getRunOrFail(auth.orgId, id, { forUpdate: true }, db);
    if (run.status !== 'draft') throw new AppError(409, 'Only a draft payroll can be recalculated');
    await buildItems(auth.orgId, run, db);
  });
  return getRun(auth, id);
}

// One-off bonus or deduction for this month only (draft only)
export async function adjustItem(auth, itemId, { bonusKobo, oneOffDeductionKobo }) {
  const item = await payrollRunModel.findItem(auth.orgId, itemId);
  if (!item) throw new AppError(404, 'Payslip not found');

  await withTransaction(async (db) => {
    const run = await getRunOrFail(auth.orgId, item.run_id, { forUpdate: true }, db);
    if (run.status !== 'draft') throw new AppError(409, 'Only a draft payroll can be changed');

    const settings = settingsForCalc(await payrollSettingsModel.get(auth.orgId, db));
    const { to } = monthRange(run.period);
    const row = (await employeePayModel.listPayable(auth.orgId, to, db)).find((r) => r.employee_id === item.employee_id);
    if (!row) throw new AppError(409, 'This employee is no longer payable — recalculate the payroll');

    const days = { daysInPeriod: item.days_in_period, daysPayable: item.days_payable, unpaidLeaveDays: item.unpaid_leave_days };
    // keep this month's loan / advance repayments that are already on the payslip
    const repayments = (typeof item.breakdown === 'string' ? JSON.parse(item.breakdown || '[]') : item.breakdown || []).filter((l) => l.kind === 'repayment');
    const result = computeItem(row, settings, days, { bonus: bonusKobo, oneOffDeduction: oneOffDeductionKobo }, repayments);
    if (result.net < 0) throw new AppError(422, 'Deductions are more than this person’s pay');
    await payrollRunModel.updateItem(item.id, result, db);
    await payrollRunModel.refreshTotals(run.id, db);
  });
  return getRun(auth, item.run_id);
}

export async function approveRun(auth, id) {
  await withTransaction(async (db) => {
    const run = await getRunOrFail(auth.orgId, id, { forUpdate: true }, db);
    if (run.status !== 'draft') throw new AppError(409, 'Only a draft payroll can be approved');
    if (!canApprove(auth, run)) {
      throw new AppError(403, 'You prepared this payroll, so someone else must approve it');
    }
    const items = await payrollRunModel.listItems(run.id, db);
    if (items.some((i) => Number(i.net_kobo) < 0)) throw new AppError(422, 'Someone’s deductions are more than their pay');

    await payrollRunModel.snapshotBankDetails(run.id, db);
    await payrollRunModel.setStatus(run.id, 'approved', { approved_by: auth.userId, approved_at: new Date() }, db);
  });
  const run = await getRunOrFail(auth.orgId, id);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'payroll.approved',
    entityType: 'payroll',
    entityId: run.id,
    details: `${run.period}: ${run.employee_count} staff, net ${formatNaira(run.net_kobo)}`,
  });
  return getRun(auth, id);
}

export async function cancelRun(auth, id) {
  const run = await getRunOrFail(auth.orgId, id);
  if (!['draft', 'approved'].includes(run.status)) throw new AppError(409, 'This payroll has already started paying and cannot be cancelled');
  await payrollRunModel.setStatus(run.id, 'cancelled');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'payroll.cancelled', entityType: 'payroll', entityId: run.id, details: run.period });
  return getRun(auth, id);
}

// Paid outside Workard (bank bulk upload, cash…). Marks everyone not yet paid as paid.
export async function markPaid(auth, id, { paidOn, method }) {
  await withTransaction(async (db) => {
    const run = await getRunOrFail(auth.orgId, id, { forUpdate: true }, db);
    if (!['approved', 'processing'].includes(run.status)) throw new AppError(409, 'Approve the payroll before paying it');
    if (Number(run.processing_count) > 0) {
      throw new AppError(409, 'Some Paystack transfers are still in progress. Wait for them to finish first.');
    }
    await payrollRunModel.markUnpaidItemsPaid(run.id, new Date(`${paidOn}T12:00:00`), db);
    await payrollRunModel.setStatus(run.id, 'paid', { paid_at: new Date(`${paidOn}T12:00:00`), payment_method: run.payment_method || method }, db);
  });
  await afterPaid(auth.orgId, id, auth.userId);
  return getRun(auth, id);
}

// Run is fully paid → record expenses (once) and tell staff their payslip is ready
export async function afterPaid(orgId, runId, userId = null) {
  const run = await getRunOrFail(orgId, runId);
  if (run.status !== 'paid') return;
  await recordExpenses(orgId, run, userId);
  await recordRepaymentsForRun(orgId, run.id); // loans & advances: this month's repayments count
  await notifyStaff(orgId, run);
  await auditModel.log({
    orgId,
    userId,
    action: 'payroll.paid',
    entityType: 'payroll',
    entityId: run.id,
    details: `${run.period}: net ${formatNaira(run.net_kobo)} via ${run.payment_method}`,
  });
}

// Salaries (gross) + employer pension go into Finance as expenses.
// request_id makes this safe to call twice — the entries are only created once.
async function recordExpenses(orgId, run, userId) {
  if (run.expenses_recorded) return;
  const categories = await financeModel.listCategories(orgId);
  const categoryId = async (name) => {
    const found = categories.find((c) => c.type === 'expense' && c.name === name);
    return found ? found.id : financeModel.createCategory(orgId, { type: 'expense', name });
  };
  const entryDate = toDateString(new Date(run.paid_at.replace(' ', 'T')));
  const entries = [
    { key: 'salaries', name: 'Salaries', amount: Number(run.gross_kobo), text: `Salaries for ${run.period} (${run.employee_count} staff)` },
    { key: 'pension', name: 'Pension contributions', amount: Number(run.pension_employer_kobo), text: `Employer pension for ${run.period}` },
  ];

  for (const e of entries) {
    if (e.amount <= 0) continue;
    try {
      await financeModel.createEntry(orgId, {
        type: 'expense',
        categoryId: await categoryId(e.name),
        amountKobo: e.amount,
        entryDate,
        description: e.text,
        party: 'Payroll',
        method: 'transfer',
        reference: `PAYROLL-${run.period}`,
        requestId: `payroll-${run.id}-${e.key}`,
        recordedBy: userId,
      });
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err; // already recorded — fine
    }
  }
  await payrollRunModel.setStatus(run.id, run.status, { expenses_recorded: 1 });
}

async function notifyStaff(orgId, run) {
  const [items, organization] = await Promise.all([payrollRunModel.listItems(run.id), organizationModel.findById(orgId)]);
  for (const item of items) {
    try {
      await sendEmail({
        to: item.email,
        ...payslipEmail({
          firstName: item.first_name,
          businessName: organization.name,
          period: run.period,
          link: `${env.clientUrls[0]}/payslips/${item.id}`,
        }),
      });
    } catch (err) {
      console.error('Payslip email failed:', err.message); // never block payroll on email
    }
  }
}

// ---------- Exports ----------
// For uploading to the bank's bulk-payment portal
export async function bankSchedule(auth, id) {
  const run = await getRunOrFail(auth.orgId, id);
  if (run.status === 'draft' || run.status === 'cancelled') throw new AppError(409, 'Approve the payroll first');
  const items = await payrollRunModel.listItems(run.id);
  return {
    period: run.period,
    rows: items.map((i) => ({
      name: `${i.first_name} ${i.last_name}`,
      accountName: i.account_name,
      accountNumber: i.account_number,
      bankName: i.bank_name,
      bankCode: i.bank_code,
      amountKobo: Number(i.net_kobo),
      narration: `Salary ${run.period}`,
    })),
  };
}

// What must be paid to the tax office (PAYE), pension fund administrators and NHF
export async function remittances(auth, id) {
  const run = await getRunOrFail(auth.orgId, id);
  const items = await payrollRunModel.listItems(run.id);
  const byPfa = {};
  for (const i of items) {
    const pfa = i.pfa_name || 'PFA not set';
    byPfa[pfa] = byPfa[pfa] || { pfa, employeeKobo: 0, employerKobo: 0, staff: [] };
    byPfa[pfa].employeeKobo += Number(i.pension_employee_kobo);
    byPfa[pfa].employerKobo += Number(i.pension_employer_kobo);
    byPfa[pfa].staff.push({ name: `${i.first_name} ${i.last_name}`, pin: i.pension_pin, totalKobo: Number(i.pension_employee_kobo) + Number(i.pension_employer_kobo) });
  }
  return {
    period: run.period,
    payeKobo: Number(run.paye_kobo),
    nhfKobo: Number(run.nhf_kobo),
    pension: Object.values(byPfa),
    paye: items.map((i) => ({ name: `${i.first_name} ${i.last_name}`, taxId: i.tax_id, grossKobo: Number(i.gross_kobo), payeKobo: Number(i.paye_kobo) })),
  };
}

// ---------- Payslips ----------
export async function myPayslips(auth) {
  if (!auth.employee) return [];
  return payrollRunModel.listForEmployee(auth.employee.id);
}

export async function getPayslip(auth, itemId) {
  const item = await payrollRunModel.findItem(auth.orgId, itemId);
  const isMine = item && auth.employee && item.employee_id === auth.employee.id;
  if (!item || (!isMine && !auth.permissions['payroll.view'])) throw new AppError(404, 'Payslip not found');
  if (isMine && !['approved', 'processing', 'paid'].includes(item.run_status)) throw new AppError(404, 'Payslip not found');
  const organization = await organizationModel.findById(auth.orgId);
  return { ...item, organization_name: organization.name };
}
