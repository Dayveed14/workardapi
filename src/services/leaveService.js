import * as leaveModel from '../models/leaveModel.js';
import * as auditModel from '../models/auditModel.js';
import { getEmployeeOrFail } from './accessService.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString, countWorkingDays } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

function requireEmployee(auth) {
  if (!auth.employee) throw new AppError(400, 'Your account is not linked to an employee profile');
  return auth.employee;
}

// How many days of each leave type are left this year
export async function getBalances(orgId, employeeId) {
  const year = new Date().getFullYear();
  const [types, used] = await Promise.all([leaveModel.listTypes(orgId), leaveModel.usedDaysByType(employeeId, year)]);
  return types
    .filter((t) => t.is_active)
    .map((t) => ({
      leaveTypeId: t.id,
      name: t.name,
      isPaid: !!t.is_paid,
      entitled: t.days_per_year,
      used: used[t.id] || 0,
      remaining: Math.max(0, t.days_per_year - (used[t.id] || 0)),
    }));
}

// ---------- Employee self-service ----------
export async function myLeave(auth) {
  const me = requireEmployee(auth);
  const [requests, balances] = await Promise.all([leaveModel.listForEmployee(me.id), getBalances(auth.orgId, me.id)]);
  return { requests, balances };
}

export async function requestLeave(auth, { leaveTypeId, startDate, endDate, reason }) {
  const me = requireEmployee(auth);

  const type = await leaveModel.findTypeById(auth.orgId, leaveTypeId);
  if (!type || !type.is_active) throw new AppError(422, 'Choose a valid leave type', { leaveTypeId: 'Choose a leave type' });
  if (endDate < startDate) throw new AppError(422, 'End date must be after start date', { endDate: 'Must be on or after the start date' });
  if (startDate < toDateString()) throw new AppError(422, 'Leave cannot start in the past', { startDate: 'Choose today or a later date' });
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) {
    throw new AppError(422, 'Split leave that crosses into a new year into two requests', { endDate: 'Must be in the same year' });
  }

  const days = countWorkingDays(startDate, endDate);
  if (days === 0) throw new AppError(422, 'Those dates fall on a weekend', { startDate: 'Choose working days' });

  if (await leaveModel.hasOverlap(me.id, startDate, endDate)) {
    throw new AppError(409, 'You already have leave booked on some of these dates');
  }

  const balance = (await getBalances(auth.orgId, me.id)).find((b) => b.leaveTypeId === type.id);
  if (!balance || balance.remaining < days) {
    throw new AppError(422, `You only have ${balance?.remaining ?? 0} day(s) of ${type.name} left`, {
      endDate: `Only ${balance?.remaining ?? 0} day(s) left`,
    });
  }

  const id = await leaveModel.createRequest(auth.orgId, { employeeId: me.id, leaveTypeId: type.id, startDate, endDate, days, reason });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'leave.requested', entityType: 'employee', entityId: me.id, details: `${type.name}: ${startDate} → ${endDate}` });
  return leaveModel.findRequestById(auth.orgId, id);
}

export async function cancelLeave(auth, requestId) {
  const me = requireEmployee(auth);
  const request = await leaveModel.findRequestById(auth.orgId, requestId);
  if (!request || request.employee_id !== me.id) throw new AppError(404, 'Leave request not found');
  if (request.status !== 'pending') throw new AppError(409, 'Only pending requests can be cancelled');
  await leaveModel.setStatus(auth.orgId, requestId, { status: 'cancelled' });
  return leaveModel.findRequestById(auth.orgId, requestId);
}

// ---------- Managers ----------
export async function listRequests(auth, scope, { status }) {
  return leaveModel.listRequests(auth.orgId, scopeCondition(scope, auth.employee), { status });
}

export async function reviewLeave(auth, requestId, { decision, note }) {
  const request = await leaveModel.findRequestById(auth.orgId, requestId);
  if (!request) throw new AppError(404, 'Leave request not found');
  if (request.status !== 'pending') throw new AppError(409, 'This request has already been reviewed');
  if (auth.employee && auth.employee.id === request.employee_id) throw new AppError(403, 'You cannot approve your own leave');

  await getEmployeeOrFail(auth, 'leave.approve', request.employee_id);

  await leaveModel.setStatus(auth.orgId, requestId, {
    status: decision,
    reviewedBy: auth.userId,
    note,
    reviewedAt: new Date(),
  });
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: `leave.${decision}`,
    entityType: 'employee',
    entityId: request.employee_id,
    details: `${request.first_name} ${request.last_name}: ${request.leave_type} ${request.start_date} → ${request.end_date}`,
  });
  return leaveModel.findRequestById(auth.orgId, requestId);
}

export async function employeeLeave(auth, employeeId) {
  await getEmployeeOrFail(auth, 'leave.view', employeeId, { allowSelf: true });
  const [requests, balances] = await Promise.all([leaveModel.listForEmployee(employeeId), getBalances(auth.orgId, employeeId)]);
  return { requests, balances };
}
