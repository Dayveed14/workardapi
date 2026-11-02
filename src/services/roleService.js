import { PERMISSIONS, SCOPES } from '../config/permissions.js';
import * as roleModel from '../models/roleModel.js';
import * as membershipModel from '../models/membershipModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as auditModel from '../models/auditModel.js';
import AppError from '../utils/AppError.js';
import { checkCanCreateRole } from './planLimitService.js';

export function getCatalog() {
  return { permissions: PERMISSIONS, scopes: SCOPES };
}

export async function listRoles(orgId) {
  return roleModel.listByOrg(orgId);
}

// Drops unknown keys and fixes scopes (non-scoped permissions are always "all")
function cleanPermissions(input) {
  const clean = {};
  for (const [key, scope] of Object.entries(input || {})) {
    const def = PERMISSIONS.find((p) => p.key === key);
    if (!def || !scope) continue;
    clean[key] = def.scoped ? (SCOPES.includes(scope) ? scope : 'own') : 'all';
  }
  return clean;
}

export async function createRole(auth, { name, description, permissions }) {
  checkCanCreateRole(auth); // Enterprise only
  if (await roleModel.findByName(auth.orgId, name)) {
    throw new AppError(409, 'A role with this name already exists', { name: 'Name already used' });
  }
  const id = await roleModel.create(auth.orgId, { name, description, permissions: cleanPermissions(permissions) });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'role.created', entityType: 'role', entityId: id, details: name });
  return roleModel.findById(auth.orgId, id);
}

export async function updateRole(auth, id, { name, description, permissions }) {
  const role = await roleModel.findById(auth.orgId, id);
  if (!role) throw new AppError(404, 'Role not found');
  if (role.isOwner) throw new AppError(409, 'The Owner role always has full access and cannot be changed');

  const sameName = await roleModel.findByName(auth.orgId, name);
  if (sameName && sameName.id !== role.id) throw new AppError(409, 'A role with this name already exists', { name: 'Name already used' });

  await roleModel.update(auth.orgId, id, { name, description, permissions: cleanPermissions(permissions) });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'role.updated', entityType: 'role', entityId: id, details: name });
  return roleModel.findById(auth.orgId, id);
}

export async function deleteRole(auth, id) {
  const role = await roleModel.findById(auth.orgId, id);
  if (!role) throw new AppError(404, 'Role not found');
  if (role.isSystem) throw new AppError(409, 'Built-in roles cannot be deleted');
  if ((await roleModel.countMembers(id)) > 0) throw new AppError(409, 'Move the people with this role to another role first');
  await roleModel.remove(auth.orgId, id);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'role.deleted', entityType: 'role', entityId: id, details: role.name });
}

// Change the role of an employee who has a login
export async function assignRole(auth, employeeId, roleId) {
  const employee = await employeeModel.findById(auth.orgId, employeeId);
  if (!employee) throw new AppError(404, 'Employee not found');
  if (!employee.user_id) throw new AppError(409, 'This employee has no login yet — send them an invite first');

  const role = await roleModel.findById(auth.orgId, roleId);
  if (!role) throw new AppError(422, 'Role not found', { roleId: 'Choose a role' });
  if (role.isOwner && !auth.role.isOwner) throw new AppError(403, 'Only an owner can make someone an owner');

  // Never leave an organisation without an owner
  if (employee.role_id && employee.role_id !== role.id) {
    const current = await roleModel.findById(auth.orgId, employee.role_id);
    if (current?.isOwner) {
      if (!auth.role.isOwner) throw new AppError(403, 'Only an owner can change another owner');
      if ((await roleModel.countMembers(current.id)) <= 1) throw new AppError(409, 'The organisation must keep at least one owner');
    }
  }

  await membershipModel.updateRole(employee.user_id, auth.orgId, role.id);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'employee.role_changed',
    entityType: 'employee',
    entityId: employee.id,
    details: `${employee.first_name} ${employee.last_name} → ${role.name}`,
  });
  return { message: `Role changed to ${role.name}` };
}
