import * as onboardingModel from '../models/onboardingModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { withTransaction } from '../config/db.js';
import { sendEmail, onboardingEmail } from './emailService.js';
import { toDateString, addDays } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// ONBOARDING
//   HR / the owner keep reusable checklists ("New employee", "New manager").
//   Starting an onboarding copies a checklist for one new joiner, with due dates
//   counted from their start date. Each item is done either by:
//     new_joiner → the new person ticks it themselves
//     hr         → HR / the owner ticks it
//   When every item is ticked, the onboarding completes by itself.
//
// Who can do what:
//   onboarding.manage (HR Manager, Owner): checklists, start, add/remove items, tick anything, cancel
//   the new joiner: sees their own onboarding, ticks only their own items
// ============================================================

const canManage = (auth) => Boolean(auth.permissions['onboarding.manage']);
const me = (auth) => auth.employee?.id ?? -1;

function requireManage(auth) {
  if (!canManage(auth)) throw new AppError(403, 'Only HR or the owner can do this');
}

// ---------- Checklists (templates) ----------
// kind: 'onboarding' or 'offboarding' (the same checklist editor is used for both)
export async function listTemplates(auth, kind = 'onboarding') {
  requireManage(auth);
  return onboardingModel.listTemplates(auth.orgId, kind);
}

export async function getTemplate(auth, id) {
  requireManage(auth);
  const template = await onboardingModel.findTemplate(auth.orgId, id);
  if (!template) throw new AppError(404, 'Checklist not found');
  return { ...template, items: await onboardingModel.listTemplateItems(id) };
}

export async function createTemplate(auth, data) {
  requireManage(auth);
  const id = await withTransaction(async (db) => {
    const templateId = await onboardingModel.createTemplate(auth.orgId, data, db);
    await onboardingModel.replaceTemplateItems(templateId, data.items, db);
    return templateId;
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'onboarding_checklist.created', details: data.name });
  return getTemplate(auth, id);
}

export async function updateTemplate(auth, id, data) {
  await getTemplate(auth, id);
  await withTransaction(async (db) => {
    await onboardingModel.updateTemplate(auth.orgId, id, data, db);
    await onboardingModel.replaceTemplateItems(id, data.items, db);
  });
  return getTemplate(auth, id);
}

export async function deleteTemplate(auth, id) {
  const template = await getTemplate(auth, id);
  await onboardingModel.archiveTemplate(auth.orgId, id); // onboardings already started keep their items
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'onboarding_checklist.deleted', details: template.name });
}

// ---------- Starting ----------
// Which checklist suits this person? Managers = a manager-type role, or people who have direct reports.
function suggestedSuits(c) {
  return /manager|supervisor|owner/i.test(c.role_name || '') || Number(c.direct_reports) > 0 ? 'managers' : 'staff';
}

export async function listCandidates(auth) {
  requireManage(auth);
  const rows = await onboardingModel.listCandidates(auth.orgId);
  return rows.map((c) => ({ ...c, hasLogin: Boolean(c.user_id), suits: suggestedSuits(c) }));
}

export async function startOnboarding(auth, { employeeId, templateId, startDate }) {
  requireManage(auth);
  const employee = await employeeModel.findById(auth.orgId, employeeId);
  if (!employee || employee.status !== 'active') throw new AppError(422, 'Choose an active employee', { employeeId: 'Choose someone' });
  const template = await onboardingModel.findTemplate(auth.orgId, templateId);
  if (!template || template.kind !== 'onboarding') throw new AppError(422, 'Choose a checklist', { templateId: 'Choose a checklist' });
  const items = await onboardingModel.listTemplateItems(templateId);
  if (!items.length) throw new AppError(422, 'This checklist has no items yet', { templateId: 'Add items to this checklist first' });

  const start = startDate || employee.start_date || toDateString();
  let id;
  try {
    id = await withTransaction(async (db) => {
      const onboardingId = await onboardingModel.create(
        auth.orgId,
        { employeeId, templateName: template.name, startDate: start, startedBy: auth.userId },
        db
      );
      for (const item of items) {
        await onboardingModel.addItem(
          onboardingId,
          { title: item.title, description: item.description, owner: item.owner, dueDate: addDays(start, item.due_day), sortOrder: item.sort_order },
          db
        );
      }
      return onboardingId;
    });
  } catch (err) {
    // UNIQUE(employee_id, active_key): already being onboarded (e.g. a double click)
    if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, `${employee.first_name} already has an onboarding in progress`);
    throw err;
  }

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'onboarding.started',
    entityType: 'employee',
    entityId: employee.id,
    details: template.name,
  });

  // Tell the new joiner (never blocks the save)
  if (employee.email) {
    try {
      const org = await organizationModel.findById(auth.orgId);
      await sendEmail({
        to: employee.email,
        ...onboardingEmail({
          firstName: employee.first_name,
          businessName: org.name,
          itemCount: items.filter((i) => i.owner === 'new_joiner').length,
          hasLogin: Boolean(employee.user_id),
          link: `${env.clientUrls[0]}/onboarding/${id}`,
        }),
      });
    } catch (err) {
      console.error('Onboarding email failed:', err.message);
    }
  }
  return getOnboarding(auth, id);
}

// ---------- Viewing ----------
export async function listOnboardings(auth, query) {
  requireManage(auth);
  return onboardingModel.list(auth.orgId, query);
}

async function getVisible(auth, id) {
  const onboarding = await onboardingModel.findById(auth.orgId, id);
  if (!onboarding || (!canManage(auth) && onboarding.employee_id !== me(auth))) throw new AppError(404, 'Onboarding not found');
  return onboarding;
}

export async function getOnboarding(auth, id) {
  const onboarding = await getVisible(auth, id);
  const isJoiner = onboarding.employee_id === me(auth);
  return {
    ...onboarding,
    items: await onboardingModel.listItems(id),
    canManage: canManage(auth),
    isJoiner,
    hasLogin: Boolean(onboarding.employee_user_id),
  };
}

// The logged-in person's own onboarding (dashboard card)
export async function getMine(auth) {
  if (!auth.employee) return null;
  const onboarding = await onboardingModel.findLatestForEmployee(auth.orgId, auth.employee.id);
  return onboarding ? getOnboarding(auth, onboarding.id) : null;
}

// ---------- Ticking items ----------
export async function setItemDone(auth, itemId, done) {
  const item = await onboardingModel.findItem(itemId);
  if (!item) throw new AppError(404, 'Item not found');
  const onboarding = await getVisible(auth, item.onboarding_id);

  // The new joiner ticks their own items; HR items are for HR / the owner
  const allowed = canManage(auth) || (item.owner === 'new_joiner' && onboarding.employee_id === me(auth));
  if (!allowed) throw new AppError(403, 'HR or the owner ticks this one off');

  await withTransaction(async (db) => {
    const locked = await onboardingModel.lock(auth.orgId, onboarding.id, db);
    if (locked.status !== 'in_progress') throw new AppError(409, 'This onboarding is finished');
    await onboardingModel.setItemDone(item.id, auth.userId, done, db);
    // Everything ticked → finished
    if (done && (await onboardingModel.countOpenItems(onboarding.id, db)) === 0) {
      await onboardingModel.setStatus(onboarding.id, 'completed', db);
    }
  });

  const result = await getOnboarding(auth, onboarding.id);
  if (result.status === 'completed') {
    await auditModel.log({
      orgId: auth.orgId,
      userId: auth.userId,
      action: 'onboarding.completed',
      entityType: 'employee',
      entityId: onboarding.employee_id,
      details: onboarding.template_name,
    });
  }
  return result;
}

// ---------- Changing one person's checklist ----------
async function getManagedInProgress(auth, id) {
  requireManage(auth);
  const onboarding = await getVisible(auth, id);
  if (onboarding.status !== 'in_progress') throw new AppError(409, 'This onboarding is finished');
  return onboarding;
}

export async function addItem(auth, id, data) {
  await getManagedInProgress(auth, id);
  await onboardingModel.addItem(id, data);
  return getOnboarding(auth, id);
}

export async function removeItem(auth, itemId) {
  const item = await onboardingModel.findItem(itemId);
  if (!item) throw new AppError(404, 'Item not found');
  await getManagedInProgress(auth, item.onboarding_id);
  await onboardingModel.removeItem(itemId);
  return getOnboarding(auth, item.onboarding_id);
}

export async function cancelOnboarding(auth, id) {
  const onboarding = await getManagedInProgress(auth, id);
  await onboardingModel.setStatus(id, 'cancelled');
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'onboarding.cancelled',
    entityType: 'employee',
    entityId: onboarding.employee_id,
    details: onboarding.template_name,
  });
  return getOnboarding(auth, id);
}
