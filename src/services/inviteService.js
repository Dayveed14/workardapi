import bcrypt from 'bcryptjs';
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import * as inviteModel from '../models/inviteModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as roleModel from '../models/roleModel.js';
import * as userModel from '../models/userModel.js';
import * as membershipModel from '../models/membershipModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { sendEmail, inviteEmail } from './emailService.js';
import { hashToken, randomToken } from './tokenService.js';
import { issueTokens, buildSession } from './authService.js';
import { password as passwordRule } from '../validators/common.js';
import AppError from '../utils/AppError.js';

const INVITE_DAYS = 7;

// Emails an employee a link to create their Workard login
export async function sendInvite(auth, employeeId, roleId) {
  const employee = await employeeModel.findById(auth.orgId, employeeId);
  if (!employee) throw new AppError(404, 'Employee not found');
  if (employee.status !== 'active') throw new AppError(409, 'This employee has exited');
  if (employee.user_id) throw new AppError(409, 'This employee already has a login');

  const role = await roleModel.findById(auth.orgId, roleId);
  if (!role) throw new AppError(422, 'Role not found', { roleId: 'Choose a role' });
  if (role.isOwner && !auth.role.isOwner) throw new AppError(403, 'Only an owner can make someone an owner');

  const now = new Date();
  const token = randomToken();
  await inviteModel.expirePendingForEmployee(employee.id, now);
  await inviteModel.create({
    orgId: auth.orgId,
    employeeId: employee.id,
    email: employee.email,
    roleId: role.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86400000),
    createdBy: auth.userId,
  });

  const organization = await organizationModel.findById(auth.orgId);
  const link = `${env.clientUrls[0]}/invite/${token}`;
  await sendEmail({
    to: employee.email,
    ...inviteEmail({ organizationName: organization.name, firstName: employee.first_name, link }),
  });

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'employee.invited',
    entityType: 'employee',
    entityId: employee.id,
    details: `${employee.email} as ${role.name}`,
  });
  return { message: `Invitation sent to ${employee.email}` };
}

async function findInviteOrFail(token) {
  const invite = await inviteModel.findValidByTokenHash(hashToken(token), new Date());
  if (!invite) throw new AppError(404, 'This invitation link is invalid or has expired');
  return invite;
}

// For the "You've been invited" page
export async function getInvite(token) {
  const invite = await findInviteOrFail(token);
  const existingUser = await userModel.findByEmail(invite.email);
  return {
    organizationName: invite.organization_name,
    email: invite.email,
    firstName: invite.first_name,
    lastName: invite.last_name,
    hasAccount: Boolean(existingUser),
  };
}

// New person → creates their login. Existing Workard user → confirms their password.
// Either way they join the organisation and are logged in.
export async function acceptInvite(req, res, token, { fullName, password }) {
  const invite = await findInviteOrFail(token);
  let user = await userModel.findByEmail(invite.email);

  if (user) {
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new AppError(401, 'Incorrect password', { password: 'Enter the password for your existing Workard account' });
  } else {
    // New login → the password must meet the same rules as sign up
    const check = passwordRule.safeParse(password);
    if (!check.success) throw new AppError(422, 'Please check the highlighted fields', { password: check.error.issues[0].message });
  }

  const userId = await withTransaction(async (db) => {
    let id = user?.id;
    if (!id) {
      id = await userModel.create(
        {
          fullName: fullName || `${invite.first_name} ${invite.last_name}`,
          email: invite.email,
          passwordHash: await bcrypt.hash(password, 12),
          emailVerified: true, // opening the emailed link proves they own the address
        },
        db
      );
    }

    const membership = await membershipModel.findByUserAndOrg(id, invite.organization_id, db);
    if (membership) {
      await membershipModel.updateRole(id, invite.organization_id, invite.role_id, db);
      await membershipModel.setStatus(id, invite.organization_id, 'active', db);
    } else {
      await membershipModel.create({ userId: id, orgId: invite.organization_id, roleId: invite.role_id }, db);
    }

    await employeeModel.linkUser(invite.organization_id, invite.employee_id, id, db);
    await inviteModel.markAccepted(invite.id, new Date(), db);
    return id;
  });

  await auditModel.log({ orgId: invite.organization_id, userId, action: 'invite.accepted', entityType: 'employee', entityId: invite.employee_id });
  await issueTokens(req, res, userId, invite.organization_id);
  return buildSession(userId, invite.organization_id);
}
