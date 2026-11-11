import * as employeeModel from '../models/employeeModel.js';
import * as branchModel from '../models/branchModel.js';
import * as departmentModel from '../models/departmentModel.js';
import * as teamModel from '../models/teamModel.js';
import * as membershipModel from '../models/membershipModel.js';
import * as auditModel from '../models/auditModel.js';
import * as offboardingModel from '../models/offboardingModel.js';
import { getEmployeeOrFail } from './accessService.js';
import { sendInvite } from './inviteService.js';
import { uploadFile, deleteFile } from './uploadService.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString } from '../utils/dates.js';
import AppError from '../utils/AppError.js';
import { checkCanAddEmployee } from './planLimitService.js';

// Makes sure branch/department/team/manager ids belong to THIS organisation
async function checkReferences(orgId, data) {
  const errors = {};
  if (data.branchId && !(await branchModel.findById(orgId, data.branchId))) errors.branchId = 'Choose a valid branch';
  if (data.departmentId && !(await departmentModel.findById(orgId, data.departmentId))) errors.departmentId = 'Choose a valid department';
  if (data.teamId && !(await teamModel.findById(orgId, data.teamId))) errors.teamId = 'Choose a valid team';
  if (data.managerId && !(await employeeModel.findById(orgId, data.managerId))) errors.managerId = 'Choose a valid manager';
  if (Object.keys(errors).length) throw new AppError(422, 'Please check the highlighted fields', errors);
}

export async function listEmployees(auth, scope, query) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const { rows, total } = await employeeModel.list(auth.orgId, scopeCondition(scope, auth.employee), {
    ...query,
    limit,
    offset: (page - 1) * limit,
  });
  return { employees: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getEmployee(auth, id) {
  return getEmployeeOrFail(auth, 'employees.view', id, { allowSelf: true });
}

export async function createEmployee(auth, data) {
  if (await employeeModel.findByEmail(auth.orgId, data.email)) {
    throw new AppError(409, 'An employee with this email already exists', { email: 'Email already used in this organisation' });
  }
  await checkReferences(auth.orgId, data);
  await checkCanAddEmployee(auth); // plan limit (Starter: 10 staff)

  const id = await employeeModel.create(auth.orgId, data);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'employee.created',
    entityType: 'employee',
    entityId: id,
    details: `${data.firstName} ${data.lastName}`,
  });

  let inviteMessage;
  if (data.sendInvite && data.roleId) {
    try {
      ({ message: inviteMessage } = await sendInvite(auth, id, data.roleId));
    } catch (err) {
      inviteMessage = `Employee saved, but the invite failed: ${err.message}`;
    }
  }

  return { employee: await employeeModel.findById(auth.orgId, id), inviteMessage };
}

export async function updateEmployee(auth, id, data) {
  await getEmployeeOrFail(auth, 'employees.edit', id);
  if (data.email) {
    const sameEmail = await employeeModel.findByEmail(auth.orgId, data.email);
    if (sameEmail && sameEmail.id !== Number(id)) {
      throw new AppError(409, 'An employee with this email already exists', { email: 'Email already used in this organisation' });
    }
  }
  await checkReferences(auth.orgId, data);
  await employeeModel.update(auth.orgId, id, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'employee.updated', entityType: 'employee', entityId: id });
  return employeeModel.findById(auth.orgId, id);
}

// Who may exit this person (used by "Exit" and by offboarding). Returns the employee.
export async function checkCanExit(auth, id) {
  const employee = await getEmployeeOrFail(auth, 'employees.exit', id);
  if (auth.employee && auth.employee.id === employee.id) throw new AppError(409, 'You cannot exit yourself');
  if (employee.status === 'exited') throw new AppError(409, 'This employee has already exited');
  if (employee.role_name && employee.membership_status === 'active') {
    const roleIsOwner = employee.role_name === 'Owner';
    if (roleIsOwner && !auth.role.isOwner) throw new AppError(403, 'Only an owner can exit another owner');
  }
  return employee;
}

// The moment someone actually leaves: status "exited", their login stops working,
// any offboarding still open is closed. Their records stay. actorUserId null = the system (last day reached).
export async function completeExit(orgId, employee, exitDate, actorUserId) {
  await employeeModel.setExited(orgId, employee.id, exitDate);
  if (employee.user_id) await membershipModel.setStatus(employee.user_id, orgId, 'disabled');
  const open = await offboardingModel.findLatestForEmployee(orgId, employee.id);
  if (open && ['notice', 'in_progress'].includes(open.status)) await offboardingModel.close(open.id, 'exited');
  await auditModel.log({
    orgId,
    userId: actorUserId,
    action: 'employee.exited',
    entityType: 'employee',
    entityId: employee.id,
    details: `${employee.first_name} ${employee.last_name}${actorUserId ? '' : ' (last day reached)'}`,
  });
}

// Exit straight away, without a checklist (offboarding has the gentler routes)
export async function exitEmployee(auth, id, { exitDate }) {
  const employee = await checkCanExit(auth, id);
  await completeExit(auth.orgId, employee, exitDate || toDateString(), auth.userId);
  return employeeModel.findById(auth.orgId, id);
}

export async function uploadPhoto(auth, id, file) {
  if (!file) throw new AppError(422, 'Choose an image to upload');
  const isSelf = auth.employee && auth.employee.id === Number(id);
  const employee = isSelf
    ? await employeeModel.findById(auth.orgId, id)
    : await getEmployeeOrFail(auth, 'employees.edit', id);

  const uploaded = await uploadFile(file, { orgId: auth.orgId, subfolder: 'photos' });
  await employeeModel.setPhoto(auth.orgId, id, uploaded.url, uploaded.publicId);
  await deleteFile(employee.photo_public_id, 'image'); // remove the old photo
  return { photoUrl: uploaded.url };
}
