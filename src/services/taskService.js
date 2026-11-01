import * as taskModel from '../models/taskModel.js';
import * as recurringTaskModel from '../models/recurringTaskModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as auditModel from '../models/auditModel.js';
import { getCustomerOrFail } from './accessService.js';
import { uploadFile, deleteFile } from './uploadService.js';
import { sendEmail, taskAssignedEmail } from './emailService.js';
import { managedCondition } from '../utils/scope.js';
import { toDateString, addDays, nextOccurrence } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// WHO CAN DO WHAT WITH A TASK
//   See it     → you're assigned to it, you created it, or the assignee is
//                inside your `tasks.view` scope / reports to you
//   Work on it → (status, checklist ticks, comments, files) the assignee,
//                or anyone who can manage it
//   Manage it  → (edit, reassign, delete) the person who created it, or anyone
//                whose `tasks.assign` scope covers the assignee / who manages them
//   Assign to  → yourself always; others inside `tasks.assign` / your direct reports
// ============================================================

const me = (auth) => auth.employee?.id ?? -1;

// SQL that limits tasks (alias t, assignee alias e) to what this person may see
function visibleCondition(auth) {
  const managed = managedCondition(auth.permissions['tasks.view'], auth.employee);
  return {
    sql: `(t.assigned_employee_id = ? OR t.created_by = ? OR ${managed.sql})`,
    params: [me(auth), auth.userId, ...managed.params],
  };
}

// Can this person assign/manage work for this employee?
async function canAssignTo(auth, employeeId) {
  if (Number(employeeId) === me(auth)) return true;
  const condition = managedCondition(auth.permissions['tasks.assign'], auth.employee);
  const employee = await employeeModel.findInScope(auth.orgId, employeeId, condition);
  return Boolean(employee);
}

async function checkAssignee(auth, employeeId) {
  const employee = await employeeModel.findById(auth.orgId, employeeId);
  if (!employee || employee.status !== 'active' || !(await canAssignTo(auth, employeeId))) {
    throw new AppError(422, 'You can only give tasks to yourself or people you manage', {
      assignedEmployeeId: 'Choose someone you manage',
    });
  }
  return employee;
}

async function getVisibleTask(auth, id) {
  const task = await taskModel.findVisible(auth.orgId, id, visibleCondition(auth));
  if (!task) throw new AppError(404, 'Task not found');
  return task;
}

async function canManage(auth, task) {
  if (task.created_by === auth.userId) return true;
  // A task someone else gave you is theirs to change — you can only work on it
  if (task.assigned_employee_id === me(auth)) return false;
  return canAssignTo(auth, task.assigned_employee_id);
}

async function requireManage(auth, task) {
  if (!(await canManage(auth, task))) throw new AppError(403, 'Only the person who set this task or their manager can change it');
}

async function requireWork(auth, task) {
  if (task.assigned_employee_id === me(auth)) return;
  await requireManage(auth, task);
}

const taskLink = (id) => `${env.clientUrls[0]}/tasks/${id}`;

// Emails the assignee — unless they gave the task to themselves. Never blocks the save.
async function notifyAssignee(auth, task) {
  if (task.assigned_employee_id === me(auth)) return;
  const employee = await employeeModel.findById(auth.orgId, task.assigned_employee_id);
  if (!employee?.email) return;
  try {
    const assignedBy = auth.userName || 'Your manager';
    await sendEmail({
      to: employee.email,
      ...taskAssignedEmail({
        firstName: employee.first_name,
        assignedBy,
        title: task.title,
        dueDate: task.due_date,
        priority: task.priority,
        link: taskLink(task.id),
      }),
    });
  } catch (err) {
    console.error('Task email failed:', err.message);
  }
}

// ---------- Lists ----------
// view = mine (assigned to me) | created (I set them for others) | team (everyone I can see)
export async function listTasks(auth, query) {
  const today = toDateString();
  const filters = {
    ...query,
    today,
    weekEnd: addDays(today, 7),
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  };
  if (query.view === 'mine') filters.assigneeId = me(auth);
  if (query.view === 'created') filters.createdBy = auth.userId;
  if (query.customerId) await getCustomerOrFail(auth, 'customers.view', query.customerId);

  const visible = visibleCondition(auth);
  const { rows, total } = await taskModel.list(auth.orgId, visible, filters);
  return { tasks: rows, total, page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)) };
}

export async function getCounts(auth) {
  const today = toDateString();
  const mine = await taskModel.counts(auth.orgId, { sql: 't.assigned_employee_id = ?', params: [me(auth)] }, today);
  const canSeeOthers = auth.permissions['tasks.view'] || (await hasReports(auth));
  const team = canSeeOthers ? await taskModel.counts(auth.orgId, visibleCondition(auth), today) : null;
  return { mine, team };
}

async function hasReports(auth) {
  if (!auth.employee) return false;
  const reports = await employeeModel.list(auth.orgId, { sql: 'e.manager_id = ?', params: [auth.employee.id] }, { status: 'active', limit: 1, offset: 0 });
  return reports.total > 0;
}

// People this person can give tasks to (for the dropdown)
export async function listAssignees(auth) {
  const condition = managedCondition(auth.permissions['tasks.assign'], auth.employee);
  const { rows } = await employeeModel.list(
    auth.orgId,
    { sql: `(${condition.sql} OR e.id = ?)`, params: [...condition.params, me(auth)] },
    { status: 'active', limit: 500, offset: 0 }
  );
  return rows.map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, job_title: e.job_title }));
}

// ---------- One task ----------
export async function getTask(auth, id) {
  const task = await getVisibleTask(auth, id);
  const [checklist, comments, attachments, manage] = await Promise.all([
    taskModel.listChecklist(id),
    taskModel.listComments(id),
    taskModel.listAttachments(id),
    canManage(auth, task),
  ]);
  const isAssignee = task.assigned_employee_id === me(auth);
  return { ...task, checklist, comments, attachments, canManage: manage, canWork: manage || isAssignee };
}

export async function createTask(auth, data) {
  const assigneeId = data.assignedEmployeeId || auth.employee?.id;
  if (!assigneeId) {
    throw new AppError(422, 'Choose who this task is for', { assignedEmployeeId: 'Choose someone' });
  }
  await checkAssignee(auth, assigneeId);
  if (data.customerId) await getCustomerOrFail(auth, 'customers.view', data.customerId);

  const id = await taskModel.create(auth.orgId, { ...data, assignedEmployeeId: assigneeId, createdBy: auth.userId });
  for (const text of data.checklist) await taskModel.addChecklistItem(id, text);

  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'task.created', entityType: 'task', entityId: id, details: data.title });
  const task = await taskModel.findById(auth.orgId, id);
  await notifyAssignee(auth, task);
  return getTask(auth, id);
}

export async function updateTask(auth, id, data) {
  const task = await getVisibleTask(auth, id);
  await requireManage(auth, task);

  const reassigned = data.assignedEmployeeId && data.assignedEmployeeId !== task.assigned_employee_id;
  if (reassigned) await checkAssignee(auth, data.assignedEmployeeId);
  else delete data.assignedEmployeeId;

  await taskModel.update(auth.orgId, id, data);
  if (reassigned) {
    await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'task.reassigned', entityType: 'task', entityId: id, details: task.title });
    await notifyAssignee(auth, await taskModel.findById(auth.orgId, id));
  }
  return getTask(auth, id);
}

export async function setStatus(auth, id, status) {
  const task = await getVisibleTask(auth, id);
  // Cancelling is a manager decision; doing the work is the assignee's
  if (status === 'cancelled') await requireManage(auth, task);
  else await requireWork(auth, task);

  await taskModel.setStatus(auth.orgId, id, status);
  if (status === 'done') {
    await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'task.completed', entityType: 'task', entityId: id, details: task.title });
  }
  return getTask(auth, id);
}

export async function deleteTask(auth, id) {
  const task = await getVisibleTask(auth, id);
  await requireManage(auth, task);
  const attachments = await taskModel.listAttachments(id);
  await taskModel.remove(auth.orgId, id);
  for (const a of attachments) await deleteFile(a.public_id, a.resource_type);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'task.deleted', entityType: 'task', entityId: id, details: task.title });
}

// ---------- Checklist, comments, files ----------
export async function addChecklistItem(auth, id, text) {
  const task = await getVisibleTask(auth, id);
  await requireWork(auth, task);
  await taskModel.addChecklistItem(id, text);
  return taskModel.listChecklist(id);
}

async function getChecklistTask(auth, itemId) {
  const item = await taskModel.findChecklistItem(itemId);
  if (!item) throw new AppError(404, 'Checklist item not found');
  return { item, task: await getVisibleTask(auth, item.task_id) };
}

export async function toggleChecklistItem(auth, itemId, isDone) {
  const { item, task } = await getChecklistTask(auth, itemId);
  await requireWork(auth, task);
  await taskModel.setChecklistDone(item.id, isDone);
  return taskModel.listChecklist(task.id);
}

export async function removeChecklistItem(auth, itemId) {
  const { item, task } = await getChecklistTask(auth, itemId);
  await requireWork(auth, task);
  await taskModel.removeChecklistItem(item.id);
  return taskModel.listChecklist(task.id);
}

export async function addComment(auth, id, body) {
  await getVisibleTask(auth, id); // anyone who can see the task can comment
  await taskModel.addComment(id, auth.userId, body);
  return taskModel.listComments(id);
}

export async function addAttachment(auth, id, file) {
  if (!file) throw new AppError(422, 'Choose a file to upload', { file: 'Choose a file' });
  const task = await getVisibleTask(auth, id);
  await requireWork(auth, task);
  const uploaded = await uploadFile(file, { orgId: auth.orgId, subfolder: 'tasks' });
  await taskModel.addAttachment(id, {
    fileName: file.originalname,
    fileUrl: uploaded.url,
    publicId: uploaded.publicId,
    resourceType: uploaded.resourceType,
    uploadedBy: auth.userId,
  });
  return taskModel.listAttachments(id);
}

export async function removeAttachment(auth, attachmentId) {
  const attachment = await taskModel.findAttachment(attachmentId);
  if (!attachment) throw new AppError(404, 'File not found');
  const task = await getVisibleTask(auth, attachment.task_id);
  if (attachment.uploaded_by !== auth.userId) await requireManage(auth, task);
  await taskModel.removeAttachment(attachment.id);
  await deleteFile(attachment.public_id, attachment.resource_type);
  return taskModel.listAttachments(task.id);
}

// ---------- Repeating tasks ----------
function recurringVisible(auth) {
  const managed = managedCondition(auth.permissions['tasks.view'], auth.employee);
  return {
    sql: `(r.assigned_employee_id = ? OR r.created_by = ? OR ${managed.sql})`,
    params: [me(auth), auth.userId, ...managed.params],
  };
}

export async function listRecurring(auth) {
  return recurringTaskModel.list(auth.orgId, recurringVisible(auth));
}

export async function createRecurring(auth, data) {
  await checkAssignee(auth, data.assignedEmployeeId);
  const nextRunOn = nextOccurrence(data, data.startsOn || toDateString());
  const id = await recurringTaskModel.create(auth.orgId, { ...data, nextRunOn, createdBy: auth.userId });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'recurring_task.created', entityType: 'task', entityId: id, details: data.title });
  // If the first date is today, make today's task straight away
  await generateRecurringTasks(toDateString(), id);
  return recurringTaskModel.findById(auth.orgId, id);
}

async function getManageableRecurring(auth, id) {
  const rec = await recurringTaskModel.findById(auth.orgId, id);
  if (!rec) throw new AppError(404, 'Repeating task not found');
  if (rec.created_by !== auth.userId && !(await canAssignTo(auth, rec.assigned_employee_id))) {
    throw new AppError(403, 'Only the person who set this up or their manager can change it');
  }
  return rec;
}

export async function updateRecurring(auth, id, data) {
  const rec = await getManageableRecurring(auth, id);
  if (data.assignedEmployeeId !== rec.assigned_employee_id) await checkAssignee(auth, data.assignedEmployeeId);
  // The schedule may have changed: work out the next date again (never before today)
  const nextRunOn = nextOccurrence(data, data.startsOn || toDateString());
  await recurringTaskModel.update(auth.orgId, id, { ...data, nextRunOn });
  return recurringTaskModel.findById(auth.orgId, id);
}

export async function deleteRecurring(auth, id) {
  const rec = await getManageableRecurring(auth, id);
  await recurringTaskModel.remove(auth.orgId, id); // tasks already made are kept
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'recurring_task.deleted', entityType: 'task', entityId: id, details: rec.title });
}

// Makes today's tasks from every repeating task that is due (all organisations).
// Called by the scheduler. Safe to run many times a day:
//   - each repeating task makes at most ONE task per date (UNIQUE recurring_task_id + due_date)
//   - if the server was off for a few days, only the LATEST missed date gets a task (no pile-up)
export async function generateRecurringTasks(today = toDateString(), onlyId = null) {
  const due = (await recurringTaskModel.listDue(today)).filter((r) => !onlyId || r.id === onlyId);
  let created = 0;
  for (const rec of due) {
    const rule = { frequency: rec.frequency, weekday: rec.weekday, monthDay: rec.month_day };
    let date = rec.next_run_on;
    let latest = date;
    while (date <= today) {
      latest = date;
      date = nextOccurrence(rule, addDays(date, 1));
    }
    if (await taskModel.createFromRecurring(rec, latest)) created += 1;
    await recurringTaskModel.setNextRun(rec.id, date);
  }
  return created;
}
