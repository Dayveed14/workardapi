import * as requestModel from '../models/staffRequestModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as employeePayModel from '../models/employeePayModel.js';
import * as payrollRunModel from '../models/payrollRunModel.js';
import * as auditModel from '../models/auditModel.js';
import { notify, notifyEmployees, reviewersFor } from './notificationService.js';
import { withTransaction } from '../config/db.js';
import { repaymentPlan } from '../config/requestRules.js';
import { getRules } from './requestSettingsService.js';
import { scopeCondition } from '../utils/scope.js';
import { formatNaira } from '../utils/money.js';
import AppError from '../utils/AppError.js';

// ============================================================
// SALARY ADVANCES & LOANS
//   employee asks  → their line manager ("Reports to") approves or rejects
//                    (no line manager → whoever has requests.approve over them)
//   payroll team   → pays the money out and clicks "Mark as paid out"
//   every payroll  → the monthly repayment is deducted automatically
//                    (shown on the payslip), until it's all repaid
// Limits, months & interest: each company's own (Settings → Loans & advances,
// requestSettingsService); the defaults are in config/requestRules.js
// ============================================================

const TYPE_NAMES = { advance: 'salary advance', loan: 'staff loan' };

function requireEmployee(auth) {
  if (!auth.employee) throw new AppError(400, 'Your account is not linked to an employee profile');
  return auth.employee;
}

// How much this person can ask for right now
export async function myLimits(auth) {
  const me = requireEmployee(auth);
  const pay = await employeePayModel.find(me.id);
  const basic = Number(pay?.basic_kobo || 0);
  const openLoans = await requestModel.openLoanTotal(me.id);
  const advanceOpen = await requestModel.hasOpenAdvance(me.id);
  const rules = await getRules(auth.orgId);
  // Loan ceiling: X% of a year's basic, never above the company's ₦ ceiling (if it set one)
  const loanCeiling = Math.min(Math.floor((basic * 12 * rules.loanMaxPercent) / 100), rules.loanMaxKobo ?? Infinity);
  return {
    basicMonthlyKobo: basic,
    advance: {
      enabled: rules.advancesEnabled,
      maxKobo: !rules.advancesEnabled || advanceOpen ? 0 : Math.floor((basic * rules.advanceMaxPercent) / 100),
      open: advanceOpen,
      maxPercent: rules.advanceMaxPercent,
      months: rules.advanceMonths,
      interestRateBp: rules.advanceInterestBp,
    },
    loan: {
      enabled: rules.loansEnabled,
      maxKobo: rules.loansEnabled ? Math.max(0, loanCeiling - openLoans) : 0,
      openKobo: openLoans,
      maxPercent: rules.loanMaxPercent,
      ceilingKobo: rules.loanMaxKobo,
      months: rules.loanMonths,
      interestRateBp: rules.loanInterestBp,
    },
  };
}

export async function createRequest(auth, { type, amountKobo, reason }) {
  const me = requireEmployee(auth);
  const limits = await myLimits(auth);
  if (!limits.basicMonthlyKobo) throw new AppError(422, 'Your salary isn’t set up in payroll yet — ask HR first');
  if (!limits[type].enabled) throw new AppError(403, `Your company doesn’t offer ${TYPE_NAMES[type]}s`);
  if (type === 'advance' && limits.advance.open) throw new AppError(409, 'You already have a salary advance open');
  const max = limits[type].maxKobo;
  if (amountKobo > max) {
    throw new AppError(422, `The most you can ask for is ${formatNaira(max)}`, { amount: `Up to ${formatNaira(max)}` });
  }

  const plan = repaymentPlan(await getRules(auth.orgId), type, amountKobo);
  const id = await requestModel.create(auth.orgId, {
    employeeId: me.id,
    type,
    amountKobo,
    reason,
    totalKobo: plan.totalKobo,
    monthlyKobo: plan.monthlyKobo,
    months: plan.months,
    interestRateBp: plan.interestRateBp,
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: `request.${type}`, entityType: 'employee', entityId: me.id, details: formatNaira(amountKobo) });

  // Tell whoever approves: the line manager, or (if none) people with requests.approve over them
  const request = await requestModel.findById(auth.orgId, id);
  const approvers = await approverUserIds(auth.orgId, request);
  await notify(auth.orgId, approvers, {
    type: 'request.new',
    title: `${auth.userName} asked for a ${TYPE_NAMES[type]} of ${formatNaira(amountKobo)}`,
    body: reason || null,
    link: '/requests?tab=approvals',
    actorUserId: auth.userId,
  });
  return request;
}

async function approverUserIds(orgId, request) {
  if (request.manager_id) {
    const manager = await employeeModel.findById(orgId, request.manager_id);
    if (manager?.user_id && manager.status === 'active') return [manager.user_id];
  }
  return (await reviewersFor(orgId, request.employee_id, 'requests.approve')).map((r) => r.userId);
}

// The line manager, or someone whose requests.approve scope covers them — never yourself
async function canDecide(auth, request) {
  if (auth.employee?.id === request.employee_id) return false;
  if (auth.employee && request.manager_id === auth.employee.id) return true;
  // With a line manager set, only they decide (the owner can always step in)
  if (request.manager_id && !auth.role.isOwner) {
    const manager = await employeeModel.findById(auth.orgId, request.manager_id);
    if (manager?.status === 'active' && manager.user_id) return false;
  }
  const scope = auth.permissions['requests.approve'];
  if (!scope) return false;
  return Boolean(await employeeModel.findInScope(auth.orgId, request.employee_id, scopeCondition(scope, auth.employee)));
}

async function getOrFail(auth, id) {
  const request = await requestModel.findById(auth.orgId, id);
  if (!request) throw new AppError(404, 'Request not found');
  return request;
}

// What each person sees in their lists
export async function listRequests(auth, view) {
  if (view === 'mine') {
    const me = requireEmployee(auth);
    return requestModel.list(auth.orgId, { sql: 'r.employee_id = ?', params: [me.id] });
  }
  if (view === 'approvals') {
    // People who report to me, plus anyone my requests.approve scope covers
    const scope = auth.permissions['requests.approve'];
    const byScope = scope ? scopeCondition(scope, auth.employee) : { sql: '1=0', params: [] };
    const rows = await requestModel.list(
      auth.orgId,
      { sql: `(e.manager_id = ? OR ${byScope.sql}) AND r.employee_id <> ?`, params: [auth.employee?.id ?? -1, ...byScope.params, auth.employee?.id ?? -1] }
    );
    const result = [];
    for (const r of rows) result.push({ ...r, canDecide: r.status === 'pending' && (await canDecide(auth, r)) });
    return result;
  }
  if (view === 'payouts') {
    if (!auth.permissions['payroll.manage']) throw new AppError(403, 'Only the payroll team can see this');
    return requestModel.list(auth.orgId, { sql: '1=1', params: [] }, { status: ['approved', 'paid_out', 'repaid'] });
  }
  throw new AppError(422, 'Unknown list');
}

export async function getRequest(auth, id) {
  const request = await getOrFail(auth, id);
  const mine = auth.employee?.id === request.employee_id;
  if (!mine && !auth.permissions['payroll.manage'] && !(await canDecide(auth, request)) && request.manager_id !== auth.employee?.id) {
    throw new AppError(404, 'Request not found');
  }
  return { ...request, repayments: await requestModel.repaymentsFor(request.id) };
}

export async function decide(auth, id, { decision, note }) {
  const request = await getOrFail(auth, id);
  if (!(await canDecide(auth, request))) throw new AppError(403, 'Only their line manager can approve this');
  await withTransaction(async (db) => {
    const locked = await requestModel.lock(auth.orgId, id, db);
    if (locked.status !== 'pending') throw new AppError(409, 'This request has already been decided');
    await requestModel.setStatus(auth.orgId, id, { status: decision, decided_by: auth.userId, decided_at: new Date(), decision_note: note || null }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: `request.${decision}`, entityType: 'employee', entityId: request.employee_id, details: `${TYPE_NAMES[request.type]} ${formatNaira(request.amount_kobo)}` });

  await notifyEmployees(auth.orgId, [request.employee_id], {
    type: `request.${decision}`,
    title: `Your ${TYPE_NAMES[request.type]} of ${formatNaira(request.amount_kobo)} was ${decision}`,
    body: note || (decision === 'approved' ? 'The payroll team will pay it out.' : null),
    link: '/requests',
    actorUserId: auth.userId,
  });
  // Approved → the payroll team pays it out
  if (decision === 'approved') {
    const payroll = await reviewersFor(auth.orgId, request.employee_id, 'payroll.manage');
    await notify(auth.orgId, payroll.map((p) => p.userId), {
      type: 'request.to_pay',
      title: `Pay out: ${request.first_name} ${request.last_name}’s ${TYPE_NAMES[request.type]} of ${formatNaira(request.amount_kobo)}`,
      link: '/requests?tab=payouts',
      actorUserId: auth.userId,
    });
  }
  return getRequest(auth, id);
}

// The payroll team has sent the money → repayments start with the next payroll
export async function markPaidOut(auth, id) {
  if (!auth.permissions['payroll.manage']) throw new AppError(403, 'Only the payroll team can do this');
  const request = await getOrFail(auth, id);
  await withTransaction(async (db) => {
    const locked = await requestModel.lock(auth.orgId, id, db);
    if (locked.status !== 'approved') throw new AppError(409, 'Only an approved request can be paid out');
    await requestModel.setStatus(auth.orgId, id, { status: 'paid_out', paid_out_by: auth.userId, paid_out_at: new Date() }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'request.paid_out', entityType: 'employee', entityId: request.employee_id, details: `${TYPE_NAMES[request.type]} ${formatNaira(request.amount_kobo)}` });
  await notifyEmployees(auth.orgId, [request.employee_id], {
    type: 'request.paid_out',
    title: `Your ${TYPE_NAMES[request.type]} of ${formatNaira(request.amount_kobo)} has been paid`,
    body: `${formatNaira(request.monthly_deduction_kobo)} will come off each payroll for ${request.months} month(s).`,
    link: '/requests',
    actorUserId: auth.userId,
  });
  return getRequest(auth, id);
}

export async function cancel(auth, id) {
  const request = await getOrFail(auth, id);
  if (request.employee_id !== auth.employee?.id) throw new AppError(404, 'Request not found');
  if (request.status !== 'pending') throw new AppError(409, 'Only a request that hasn’t been decided can be cancelled');
  await requestModel.setStatus(auth.orgId, id, { status: 'cancelled' });
  return getRequest(auth, id);
}

// ---------- Payroll ----------
// This month's repayments for everyone, as payslip lines: { employeeId: [{ requestId, label, amountKobo }] }
export async function repaymentLines(orgId, db) {
  const rows = await requestModel.listRepaying(orgId, db);
  const lines = {};
  for (const r of rows) {
    const amount = Math.min(Number(r.monthly_deduction_kobo), Number(r.balance_kobo));
    if (amount <= 0) continue;
    (lines[r.employee_id] ||= []).push({ kind: 'repayment', requestId: r.id, label: r.type === 'loan' ? 'Staff loan repayment' : 'Salary advance repayment', amountKobo: amount });
  }
  return lines;
}

// A payroll was paid → count the repayments that were on its payslips (each once only)
export async function recordRepaymentsForRun(orgId, runId) {
  const items = await payrollRunModel.listItems(runId);
  let counted = 0;
  for (const item of items) {
    const lines = typeof item.breakdown === 'string' ? JSON.parse(item.breakdown || '[]') : item.breakdown || [];
    for (const line of lines.filter((l) => l.kind === 'repayment')) {
      if (await requestModel.recordRepayment(line.requestId, runId, line.amountKobo)) counted += 1;
    }
  }
  return counted;
}
