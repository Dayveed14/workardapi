import * as offboardingModel from '../models/offboardingModel.js';
import * as onboardingModel from '../models/onboardingModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { checkCanExit, completeExit } from './employeeService.js';
import { notify, reviewersFor, emailEach } from './notificationService.js';
import { sendEmail, resignationReceivedEmail, offboardingChecklistEmail } from './emailService.js';
import { withTransaction } from '../config/db.js';
import { toDateString, toDateTimeString, addDays, formatDateLong as formatDate } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// OFFBOARDING — someone leaving the company
//
//   RESIGNATION  the employee clicks "Resign" (Requests → Resignation), or HR records it
//                → the notice period starts (Settings: organizations.notice_days, default 30)
//                → HR + the people who can exit them are told (bell + email)
//                → HR sends an offboarding checklist (handover note, documents, assets …)
//                → the leaver ticks their items before the last day; HR ticks theirs
//
//   TERMINATION  HR clicks Exit → "With a 24-hour checklist"
//                → the person is told (kindly) and gets the checklist, due within 24 hours
//
//   Either way their log-in stops at `ends_at` — automatically (the 15-minute job),
//   or earlier when HR clicks "Exit now". Their records stay.
//
// Who: HR / owner (onboarding.manage) run it; starting one for someone needs employees.exit
// over that person. The leaver sees and ticks only their own items.
// ============================================================

const canManage = (auth) => Boolean(auth.permissions['onboarding.manage']);
const myId = (auth) => auth.employee?.id ?? -1;
const name = (o) => `${o.first_name} ${o.last_name}`;
const endOfDay = (date) => `${date} 23:59:59`;
const link = (id) => `/offboarding/${id}`;

function requireManage(auth) {
  if (!canManage(auth)) throw new AppError(403, 'Only HR or the owner can do this');
}

// ---------- Notice period ----------
export async function getSettings(auth) {
  return { noticeDays: await offboardingModel.noticeDays(auth.orgId) };
}

export async function setNoticeDays(auth, days) {
  requireManage(auth);
  await offboardingModel.setNoticeDays(auth.orgId, days);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.notice_changed', details: `${days} days` });
  return getSettings(auth);
}

// ---------- Viewing ----------
export async function list(auth, query) {
  requireManage(auth);
  return offboardingModel.list(auth.orgId, query);
}

async function getVisible(auth, id) {
  const o = await offboardingModel.findById(auth.orgId, id);
  if (!o || (!canManage(auth) && o.employee_id !== myId(auth))) throw new AppError(404, 'Not found');
  return o;
}

export async function get(auth, id) {
  const o = await getVisible(auth, id);
  return {
    ...o,
    items: await offboardingModel.listItems(o.id),
    canManage: canManage(auth),
    isLeaver: o.employee_id === myId(auth),
    open: ['notice', 'in_progress'].includes(o.status),
  };
}

// The logged-in person's own (Requests → Resignation, and the dashboard banner)
export async function mine(auth) {
  if (!auth.employee) return { offboarding: null, noticeDays: await offboardingModel.noticeDays(auth.orgId) };
  const latest = await offboardingModel.findLatestForEmployee(auth.orgId, auth.employee.id);
  const open = latest && ['notice', 'in_progress'].includes(latest.status) ? latest : null;
  return { offboarding: open ? await get(auth, open.id) : null, noticeDays: await offboardingModel.noticeDays(auth.orgId) };
}

// ---------- Starting ----------
async function tellManagers(orgId, employeeId, note, emailFor) {
  const people = await reviewersFor(orgId, employeeId, 'employees.exit');
  await notify(orgId, people.map((p) => p.userId), note);
  if (emailFor) await emailEach(people, emailFor);
}

async function createOffboarding(auth, employee, { exitType, reason, lastDay, endsAt, byEmployee }) {
  try {
    return await offboardingModel.create(auth.orgId, {
      employeeId: employee.id,
      exitType,
      reason,
      startedBy: auth.userId,
      byEmployee,
      noticeStart: toDateTimeString(),
      lastDay,
      endsAt,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, `${employee.first_name} is already leaving — see Offboarding`);
    throw err;
  }
}

// The employee resigns. Their last day = today + the notice period.
export async function resign(auth, { reason }) {
  if (!auth.employee) throw new AppError(400, 'Your account is not linked to an employee profile');
  if (auth.role.isOwner) throw new AppError(409, 'The owner can’t resign here — transfer ownership first');
  const employee = await employeeModel.findById(auth.orgId, auth.employee.id);
  const days = await offboardingModel.noticeDays(auth.orgId);
  const lastDay = addDays(toDateString(), days);
  const id = await createOffboarding(auth, employee, { exitType: 'resignation', reason, lastDay, endsAt: endOfDay(lastDay), byEmployee: true });

  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.resigned', entityType: 'employee', entityId: employee.id, details: `last day ${lastDay}` });
  await tellManagers(
    auth.orgId,
    employee.id,
    { type: 'offboarding.resigned', title: `${name(employee)} has resigned — last day ${formatDate(lastDay)}`, body: reason?.slice(0, 200) || 'Send them an offboarding checklist.', link: link(id), actorUserId: auth.userId },
    (p) => resignationReceivedEmail({ firstName: p.name.split(' ')[0], employeeName: name(employee), lastDay: formatDate(lastDay), reason, link: `${env.clientUrls[0]}${link(id)}` })
  );
  return get(auth, id);
}

// HR starts it: a resignation they received (on paper / by email), or a termination (24 hours)
export async function startByHr(auth, { employeeId, exitType, reason, lastDay, templateId }) {
  requireManage(auth);
  const employee = await checkCanExit(auth, employeeId);
  let endsAt;
  if (exitType === 'termination') {
    const end = new Date(Date.now() + 24 * 3600_000);
    endsAt = toDateTimeString(end);
    lastDay = toDateString(end);
  } else {
    lastDay = lastDay || addDays(toDateString(), await offboardingModel.noticeDays(auth.orgId));
    if (lastDay < toDateString()) throw new AppError(422, 'The last day can’t be in the past', { lastDay: 'Today or later' });
    endsAt = endOfDay(lastDay);
  }
  if (templateId) {
    // Check the checklist first, so a bad choice doesn't leave a half-started exit behind
    const template = await onboardingModel.findTemplate(auth.orgId, templateId);
    if (!template || template.kind !== 'offboarding') throw new AppError(422, 'Choose an offboarding checklist', { templateId: 'Choose a checklist' });
    if (!(await onboardingModel.listTemplateItems(templateId)).length) throw new AppError(422, 'This checklist has no items yet', { templateId: 'Add items to this checklist first' });
  }
  const id = await createOffboarding(auth, employee, { exitType, reason, lastDay, endsAt, byEmployee: false });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: `offboarding.${exitType === 'termination' ? 'terminated' : 'resignation_recorded'}`, entityType: 'employee', entityId: employee.id, details: `last day ${lastDay}` });
  if (templateId) return sendChecklist(auth, id, templateId);
  return get(auth, id);
}

// ---------- The checklist ----------
// Copies an offboarding checklist for this person. Each item is due `day` days after the
// notice started, but never after their access ends (termination: everything within 24 hours).
export async function sendChecklist(auth, id, templateId) {
  requireManage(auth);
  const o = await getVisible(auth, id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  if (o.template_name) throw new AppError(409, 'A checklist was already sent — add or remove items instead');
  const template = await onboardingModel.findTemplate(auth.orgId, templateId);
  if (!template || template.kind !== 'offboarding') throw new AppError(422, 'Choose an offboarding checklist', { templateId: 'Choose a checklist' });
  const items = await onboardingModel.listTemplateItems(templateId);
  if (!items.length) throw new AppError(422, 'This checklist has no items yet', { templateId: 'Add items to this checklist first' });

  const start = new Date(String(o.notice_start).replace(' ', 'T'));
  const end = new Date(String(o.ends_at).replace(' ', 'T'));
  await withTransaction(async (db) => {
    for (const item of items) {
      // Termination: everything is due when the 24 hours end
      const due = o.exit_type === 'termination' ? new Date(end) : new Date(Math.min(start.getTime() + item.due_day * 86400_000, end.getTime()));
      if (o.exit_type === 'resignation') due.setHours(23, 59, 0, 0);
      await offboardingModel.addItem(
        o.id,
        { title: item.title, description: item.description, owner: item.owner === 'hr' ? 'hr' : 'employee', dueAt: toDateTimeString(due > end ? end : due), asksForNote: item.asks_for_note, sortOrder: item.sort_order },
        db
      );
    }
    await offboardingModel.update(o.id, { template_name: template.name, checklist_sent_at: toDateTimeString(), status: 'in_progress' }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.checklist_sent', entityType: 'employee', entityId: o.employee_id, details: template.name });

  // Tell the leaver (bell + email). Kind words, especially for a termination.
  const termination = o.exit_type === 'termination';
  const deadline = termination ? `${formatDate(toDateString(end))} ${end.toTimeString().slice(0, 5)}` : formatDate(o.last_day);
  if (o.employee_user_id) {
    await notify(auth.orgId, [o.employee_user_id], {
      type: 'offboarding.checklist',
      title: termination ? 'Please complete your exit steps within 24 hours' : 'Your offboarding checklist is ready',
      body: `${items.filter((i) => i.owner !== 'hr').length} steps to finish by ${deadline}.`,
      link: link(o.id),
      actorUserId: auth.userId,
    });
  }
  if (o.employee_email) {
    const org = await organizationModel.findById(auth.orgId);
    await sendEmail({
      to: o.employee_email,
      ...offboardingChecklistEmail({
        firstName: o.first_name,
        businessName: org.name,
        itemCount: items.filter((i) => i.owner !== 'hr').length,
        deadline,
        termination,
        link: `${env.clientUrls[0]}${link(o.id)}`,
      }),
    }).catch((err) => console.error('Offboarding email failed:', err.message));
  }
  return get(auth, o.id);
}

export async function setItemDone(auth, itemId, { done, note }) {
  const item = await offboardingModel.findItem(itemId);
  if (!item) throw new AppError(404, 'Item not found');
  const o = await getVisible(auth, item.offboarding_id);
  const isLeaver = o.employee_id === myId(auth);
  if (!(canManage(auth) || (item.owner === 'employee' && isLeaver))) throw new AppError(403, 'HR ticks this one off');
  if (done && item.asks_for_note && isLeaver && !(note || item.note || '').trim()) {
    throw new AppError(422, 'Please write a short note for this one', { note: 'Write a short note' });
  }

  let finished = false;
  await withTransaction(async (db) => {
    const locked = await offboardingModel.lock(auth.orgId, o.id, db);
    if (!['notice', 'in_progress'].includes(locked.status)) throw new AppError(409, 'This offboarding is finished');
    await offboardingModel.setItemDone(item.id, { userId: auth.userId, done, note: note?.trim() || null }, db);
    const open = await offboardingModel.countOpenItems(o.id, db);
    if (done && open === 0 && !locked.checklist_done_at) {
      await offboardingModel.update(o.id, { checklist_done_at: toDateTimeString() }, db);
      finished = true;
    }
    if (!done && locked.checklist_done_at) await offboardingModel.update(o.id, { checklist_done_at: null }, db);
  });

  if (finished) {
    await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.checklist_done', entityType: 'employee', entityId: o.employee_id });
    await tellManagers(auth.orgId, o.employee_id, {
      type: 'offboarding.done',
      title: `${name(o)}’s offboarding checklist is complete`,
      body: `They leave on ${formatDate(o.last_day)} — or click “Exit now”.`,
      link: link(o.id),
      actorUserId: auth.userId,
    });
  }
  return get(auth, o.id);
}

export async function addItem(auth, id, data) {
  requireManage(auth);
  const o = await getVisible(auth, id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  await offboardingModel.addItem(o.id, { ...data, dueAt: data.dueDate ? `${data.dueDate} 23:59:00` : o.ends_at });
  await offboardingModel.update(o.id, { checklist_done_at: null, ...(o.template_name ? {} : { template_name: 'Custom', checklist_sent_at: toDateTimeString(), status: 'in_progress' }) });
  return get(auth, o.id);
}

export async function removeItem(auth, itemId) {
  requireManage(auth);
  const item = await offboardingModel.findItem(itemId);
  if (!item) throw new AppError(404, 'Item not found');
  const o = await getVisible(auth, item.offboarding_id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  await offboardingModel.removeItem(item.id);
  return get(auth, o.id);
}

// ---------- Changing the dates, ending ----------
export async function setLastDay(auth, id, lastDay) {
  requireManage(auth);
  const o = await getVisible(auth, id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  if (lastDay < toDateString()) throw new AppError(422, 'The last day can’t be in the past', { lastDay: 'Today or later' });
  await offboardingModel.update(o.id, { last_day: lastDay, ends_at: endOfDay(lastDay) });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.last_day_changed', entityType: 'employee', entityId: o.employee_id, details: lastDay });
  if (o.employee_user_id) {
    await notify(auth.orgId, [o.employee_user_id], { type: 'offboarding.date', title: `Your last day is now ${formatDate(lastDay)}`, body: null, link: link(o.id), actorUserId: auth.userId });
  }
  return get(auth, o.id);
}

// HR ends it now: the person leaves today
export async function exitNow(auth, id) {
  requireManage(auth);
  const o = await getVisible(auth, id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  const employee = await checkCanExit(auth, o.employee_id);
  await completeExit(auth.orgId, employee, toDateString(), auth.userId);
  return get(auth, o.id);
}

// The employee changes their mind (only while it's their own resignation)
export async function withdraw(auth, id) {
  const o = await getVisible(auth, id);
  if (o.employee_id !== myId(auth) || o.exit_type !== 'resignation') throw new AppError(403, 'Only the person who resigned can withdraw it');
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This is already finished');
  await offboardingModel.close(o.id, 'withdrawn');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.withdrawn', entityType: 'employee', entityId: o.employee_id });
  await tellManagers(auth.orgId, o.employee_id, { type: 'offboarding.withdrawn', title: `${name(o)} withdrew their resignation`, body: 'They’re staying. Nothing else changes.', link: link(o.id), actorUserId: auth.userId });
  return get(auth, o.id);
}

// HR calls it off (e.g. they agreed to stay, or the termination was reversed)
export async function cancel(auth, id) {
  requireManage(auth);
  const o = await getVisible(auth, id);
  if (!['notice', 'in_progress'].includes(o.status)) throw new AppError(409, 'This offboarding is finished');
  await offboardingModel.close(o.id, 'cancelled');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'offboarding.cancelled', entityType: 'employee', entityId: o.employee_id });
  if (o.employee_user_id) {
    await notify(auth.orgId, [o.employee_user_id], { type: 'offboarding.cancelled', title: 'Your exit has been called off', body: 'You’re staying with the company. Speak to HR if you have questions.', link: '/dashboard', actorUserId: auth.userId });
  }
  return get(auth, o.id);
}

// ---------- The 15-minute job: whoever's time is up leaves ----------
export async function processEndings() {
  const ended = await offboardingModel.listEnded();
  for (const o of ended) {
    const employee = await employeeModel.findById(o.organization_id, o.employee_id);
    if (!employee || employee.status === 'exited') {
      await offboardingModel.close(o.id, 'exited');
      continue;
    }
    const open = await offboardingModel.countOpenItems(o.id);
    await completeExit(o.organization_id, employee, String(o.last_day).slice(0, 10), null);
    await tellManagers(o.organization_id, o.employee_id, {
      type: 'offboarding.exited',
      title: `${employee.first_name} ${employee.last_name} has left`,
      body: open ? `${open} checklist item${open === 1 ? ' was' : 's were'} not finished.` : 'Their checklist was complete.',
      link: link(o.id),
    });
  }
  return ended.length;
}
