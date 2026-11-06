import { notify, notifyEmployees } from './notificationService.js';
import * as salesModel from '../models/salesModel.js';
import * as customerModel from '../models/customerModel.js';
import * as interactionModel from '../models/interactionModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as paymentModel from '../models/paymentModel.js';
import * as auditModel from '../models/auditModel.js';
import { getCustomerOrFail } from './accessService.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString, addDays } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

// Who may a customer be assigned to?
//   scope "own"  → only yourself
//   other scopes → anyone inside your scope (e.g. a supervisor → their team)
//   null         → unassigned (only for people who can manage all customers)
async function resolveAssignee(auth, requestedId) {
  const scope = auth.permissions['customers.manage'];

  if (scope === 'own') {
    if (!auth.employee) throw new AppError(400, 'Your account is not linked to an employee profile');
    return auth.employee.id;
  }
  if (!requestedId) {
    if (scope === 'all') return null;
    throw new AppError(422, 'Choose who handles this customer', { assignedEmployeeId: 'Choose someone' });
  }

  const employee = await employeeModel.findInScope(auth.orgId, requestedId, scopeCondition(scope, auth.employee));
  if (!employee || employee.status !== 'active') {
    throw new AppError(422, 'You can only assign customers to people you manage', { assignedEmployeeId: 'Choose someone you manage' });
  }
  return employee.id;
}

// ---------- Telling people (the bell) ----------
const STAGE_NAMES = { lead: 'Lead', prospect: 'Prospect', customer: 'Customer', lost: 'Lost', inactive: 'Inactive' };
const ACTIVITY_NAMES = { call: 'a call', meeting: 'a meeting', note: 'a note', email: 'an email', whatsapp: 'a WhatsApp chat', enquiry: 'an enquiry', complaint: 'a complaint' };

// "Ada assigned you a lead: Zenith Foods" (not when you assign one to yourself)
async function tellAssignee(auth, customer, employeeId) {
  if (!employeeId || employeeId === auth.employee?.id) return;
  await notifyEmployees(auth.orgId, [employeeId], {
    type: 'customer.assigned',
    title: `${auth.userName} assigned you ${customer.stage === 'customer' ? 'a customer' : `a ${STAGE_NAMES[customer.stage].toLowerCase()}`}: ${customer.name}`,
    link: `/customers/${customer.id}`,
    actorUserId: auth.userId,
  });
}

// The person handling a customer did something → tell whoever assigned it to them
async function tellAssigner(auth, customer, what) {
  const assigner = customer.assigned_by || customer.created_by;
  if (!assigner || assigner === auth.userId) return;
  await notify(auth.orgId, [assigner], {
    type: 'customer.updated',
    title: `${auth.userName} ${what}`,
    link: `/customers/${customer.id}`,
    actorUserId: auth.userId,
  });
}

// Leads / customers someone else gave me, and who (dashboard: "Assigned to you")
export async function assignedToMe(auth) {
  if (!auth.employee) return [];
  return customerModel.listAssignedByOthers(auth.orgId, auth.employee.id, auth.userId);
}

// ---------- Customers ----------
export async function listCustomers(auth, scope, query) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const { rows, total } = await customerModel.list(auth.orgId, scopeCondition(scope, auth.employee), {
    ...query,
    limit,
    offset: (page - 1) * limit,
  });
  // How many in each stage (whole scope, ignoring the search) — for the stage chips
  const stageCounts = await customerModel.countByStage(auth.orgId, scopeCondition(scope, auth.employee));
  return { customers: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)), stageCounts };
}

export async function getCustomer(auth, id) {
  return getCustomerOrFail(auth, 'customers.view', id);
}

export async function listOptions(orgId) {
  return customerModel.options(orgId);
}

export async function createCustomer(auth, data) {
  // No one chosen → the person creating it handles it
  const requested = data.assignedEmployeeId || auth.employee?.id || null;
  const assignedEmployeeId = await resolveAssignee(auth, requested);
  const id = await customerModel.create(auth.orgId, { ...data, assignedEmployeeId, createdBy: auth.userId });
  await customerModel.setAssignment(auth.orgId, id, assignedEmployeeId, auth.userId);
  await salesModel.recordChange({ orgId: auth.orgId, customerId: id, toStage: data.stage || 'lead', changedBy: auth.userId });
  await tellAssignee(auth, { id, name: data.name, stage: data.stage || 'lead' }, assignedEmployeeId);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'customer.created', entityType: 'customer', entityId: id, details: data.name });
  return customerModel.findById(auth.orgId, id);
}

export async function updateCustomer(auth, id, data) {
  const customer = await getCustomerOrFail(auth, 'customers.manage', id);
  const { stage, assignedEmployeeId: requestedAssignee, ...changes } = data;

  await customerModel.update(auth.orgId, id, changes);

  // A new person handles it → remember who gave it to them, and tell them
  let reassigned = false;
  if (requestedAssignee !== undefined && requestedAssignee !== customer.assigned_employee_id) {
    const assignee = await resolveAssignee(auth, requestedAssignee);
    if (assignee !== customer.assigned_employee_id) {
      await customerModel.setAssignment(auth.orgId, id, assignee, auth.userId);
      await tellAssignee(auth, { ...customer, stage: stage || customer.stage }, assignee);
      reassigned = true;
    }
  }

  // keeps the stage history, and tells whoever assigned it
  if (stage && (await customerModel.setStage(auth.orgId, id, stage, auth.userId))) {
    await tellAssigner(auth, customer, `moved ${customer.name} from ${STAGE_NAMES[customer.stage]} to ${STAGE_NAMES[stage]}`);
  }
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: reassigned ? 'customer.reassigned' : 'customer.updated',
    entityType: 'customer',
    entityId: id,
    details: customer.name,
  });
  return customerModel.findById(auth.orgId, id);
}

// ---------- Activity (notes, calls, meetings, enquiries, complaints) ----------
export async function listActivity(auth, customerId) {
  await getCustomerOrFail(auth, 'customers.view', customerId);
  return interactionModel.listByCustomer(auth.orgId, customerId);
}

export async function addActivity(auth, customerId, data) {
  const customer = await getCustomerOrFail(auth, 'customers.manage', customerId);

  // Enquiries and complaints are "cases" that stay open until resolved
  const status = ['enquiry', 'complaint'].includes(data.type) ? 'open' : null;
  // The follow-up goes to the account owner, or whoever logged it
  const employeeId = customer.assigned_employee_id || auth.employee?.id || null;

  const id = await interactionModel.create(auth.orgId, {
    ...data,
    customerId,
    status,
    employeeId,
    createdBy: auth.userId,
  });
  await tellAssigner(auth, customer, `logged ${ACTIVITY_NAMES[data.type] || 'an update'} on ${customer.name}: ${data.subject}`);
  return interactionModel.findById(auth.orgId, id);
}

async function getInteractionOrFail(auth, interactionId) {
  const interaction = await interactionModel.findById(auth.orgId, interactionId);
  if (!interaction) throw new AppError(404, 'Activity not found');
  await getCustomerOrFail(auth, 'customers.manage', interaction.customer_id);
  return interaction;
}

export async function resolveCase(auth, interactionId) {
  const interaction = await getInteractionOrFail(auth, interactionId);
  if (interaction.status !== 'open') throw new AppError(409, 'This is not an open enquiry or complaint');
  await interactionModel.setResolved(interaction.id, new Date());
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: `${interaction.type}.resolved`,
    entityType: 'customer',
    entityId: interaction.customer_id,
    details: interaction.subject,
  });
  return interactionModel.findById(auth.orgId, interactionId);
}

export async function completeFollowUp(auth, interactionId) {
  const interaction = await getInteractionOrFail(auth, interactionId);
  if (!interaction.follow_up_on) throw new AppError(409, 'This activity has no follow-up');
  await interactionModel.setFollowUpDone(interaction.id);
  return interactionModel.findById(auth.orgId, interactionId);
}

// Follow-ups not done yet: overdue, today and the next 7 days
export async function listFollowUps(auth, scope) {
  const condition = scopeCondition(scope, auth.employee);
  return interactionModel.listFollowUps(auth.orgId, condition, addDays(toDateString(), 7));
}

export async function listOpenCases(auth, scope) {
  return interactionModel.listOpenCases(auth.orgId, scopeCondition(scope, auth.employee));
}

export async function listPayments(auth, customerId) {
  await getCustomerOrFail(auth, 'customers.view', customerId);
  return paymentModel.listByCustomer(auth.orgId, customerId);
}
