import { DEFAULT_ROLES, DEFAULT_LEAVE_TYPES, DEFAULT_FINANCE_CATEGORIES } from '../config/permissions.js';
import * as reviewModel from '../models/reviewModel.js';
import * as onboardingModel from '../models/onboardingModel.js';
import * as invoiceModel from '../models/invoiceModel.js';
import * as financeModel from '../models/financeModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as roleModel from '../models/roleModel.js';
import * as branchModel from '../models/branchModel.js';
import * as departmentModel from '../models/departmentModel.js';
import * as teamModel from '../models/teamModel.js';
import * as leaveModel from '../models/leaveModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as auditModel from '../models/auditModel.js';
import AppError from '../utils/AppError.js';
import { checkCanAddBranch } from './planLimitService.js';

// Called once when a company signs up: default roles, leave types and a first branch.
export async function seedOrganization(orgId, db) {
  let ownerRoleId;
  for (const role of DEFAULT_ROLES) {
    const id = await roleModel.create(
      orgId,
      { name: role.name, description: role.description, permissions: role.permissions, isSystem: true, isOwner: !!role.isOwner },
      db
    );
    if (role.isOwner) ownerRoleId = id;
  }
  for (const type of DEFAULT_LEAVE_TYPES) {
    await leaveModel.createType(orgId, type, db);
  }
  // Phase 2: invoice numbering/settings + income & expense categories
  await invoiceModel.createSettings(orgId, db);
  for (const [type, names] of Object.entries(DEFAULT_FINANCE_CATEGORIES)) {
    for (const name of names) await financeModel.createCategory(orgId, { type, name }, db);
  }
  // Phase 3B: review settings + default review criteria
  await reviewModel.ensureDefaults(orgId, db);
  await onboardingModel.ensureDefaults(orgId, db); // two starter onboarding checklists
  const branchId = await branchModel.create(orgId, { name: 'Head Office', clockInPolicy: 'none' }, db);
  return { ownerRoleId, branchId };
}

export async function getOrganization(orgId) {
  return organizationModel.findById(orgId);
}

export async function updateOrganization(auth, data) {
  await organizationModel.update(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'organization.updated', details: data.name });
  return organizationModel.findById(auth.orgId);
}

// Everything forms need for dropdowns, in one call
export async function getStructure(orgId) {
  const [branches, departments, teams, leaveTypes, employees, roles] = await Promise.all([
    branchModel.listByOrg(orgId),
    departmentModel.listByOrg(orgId),
    teamModel.listByOrg(orgId),
    leaveModel.listTypes(orgId),
    employeeModel.listOptions(orgId),
    roleModel.listByOrg(orgId),
  ]);
  return {
    branches,
    departments,
    teams,
    leaveTypes,
    employees,
    roles: roles.map(({ id, name, isOwner }) => ({ id, name, isOwner })),
  };
}

// ---------- Branches ----------
export async function createBranch(auth, data) {
  await checkCanAddBranch(auth); // plan limit
  const id = await branchModel.create(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'branch.created', entityType: 'branch', entityId: id, details: data.name });
  return branchModel.findById(auth.orgId, id);
}

export async function updateBranch(auth, id, data) {
  if (!(await branchModel.findById(auth.orgId, id))) throw new AppError(404, 'Branch not found');
  await branchModel.update(auth.orgId, id, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'branch.updated', entityType: 'branch', entityId: id, details: data.name });
  return branchModel.findById(auth.orgId, id);
}

export async function deleteBranch(auth, id) {
  const branches = await branchModel.listByOrg(auth.orgId);
  const branch = branches.find((b) => b.id === Number(id));
  if (!branch) throw new AppError(404, 'Branch not found');
  if (Number(branch.employee_count) > 0) throw new AppError(409, 'Move the employees in this branch first');
  if (branches.length === 1) throw new AppError(409, 'An organisation needs at least one branch');
  await branchModel.remove(auth.orgId, id);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'branch.deleted', entityType: 'branch', entityId: id, details: branch.name });
}

// ---------- Departments ----------
export async function createDepartment(auth, data) {
  const id = await departmentModel.create(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'department.created', entityType: 'department', entityId: id, details: data.name });
  return departmentModel.findById(auth.orgId, id);
}

export async function updateDepartment(auth, id, data) {
  if (!(await departmentModel.findById(auth.orgId, id))) throw new AppError(404, 'Department not found');
  await departmentModel.update(auth.orgId, id, data);
  return departmentModel.findById(auth.orgId, id);
}

export async function deleteDepartment(auth, id) {
  if (!(await departmentModel.findById(auth.orgId, id))) throw new AppError(404, 'Department not found');
  await departmentModel.remove(auth.orgId, id); // employees keep working; their department is cleared
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'department.deleted', entityType: 'department', entityId: id });
}

// ---------- Teams ----------
async function checkTeamRefs(orgId, { departmentId, supervisorEmployeeId }) {
  if (departmentId && !(await departmentModel.findById(orgId, departmentId))) {
    throw new AppError(422, 'Department not found', { departmentId: 'Choose a valid department' });
  }
  if (supervisorEmployeeId && !(await employeeModel.findById(orgId, supervisorEmployeeId))) {
    throw new AppError(422, 'Supervisor not found', { supervisorEmployeeId: 'Choose a valid employee' });
  }
}

export async function createTeam(auth, data) {
  await checkTeamRefs(auth.orgId, data);
  const id = await teamModel.create(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'team.created', entityType: 'team', entityId: id, details: data.name });
  return teamModel.findById(auth.orgId, id);
}

export async function updateTeam(auth, id, data) {
  if (!(await teamModel.findById(auth.orgId, id))) throw new AppError(404, 'Team not found');
  await checkTeamRefs(auth.orgId, data);
  await teamModel.update(auth.orgId, id, data);
  return teamModel.findById(auth.orgId, id);
}

export async function deleteTeam(auth, id) {
  if (!(await teamModel.findById(auth.orgId, id))) throw new AppError(404, 'Team not found');
  await teamModel.remove(auth.orgId, id);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'team.deleted', entityType: 'team', entityId: id });
}

// ---------- Leave types ----------
export async function createLeaveType(auth, data) {
  const id = await leaveModel.createType(auth.orgId, data);
  return leaveModel.findTypeById(auth.orgId, id);
}

export async function updateLeaveType(auth, id, data) {
  if (!(await leaveModel.findTypeById(auth.orgId, id))) throw new AppError(404, 'Leave type not found');
  await leaveModel.updateType(auth.orgId, id, data);
  return leaveModel.findTypeById(auth.orgId, id);
}

export async function listAuditLogs(orgId, query) {
  return auditModel.list(orgId, query);
}
