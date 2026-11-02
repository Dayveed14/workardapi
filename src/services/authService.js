import bcrypt from 'bcryptjs';
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import * as userModel from '../models/userModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as membershipModel from '../models/membershipModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as refreshTokenModel from '../models/refreshTokenModel.js';
import * as auditModel from '../models/auditModel.js';
import * as subscriptionModel from '../models/subscriptionModel.js';
import * as otpService from './otpService.js';
import * as tokenService from './tokenService.js';
import { seedOrganization } from './organizationService.js';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../utils/cookies.js';
import { toDateString } from '../utils/dates.js';
import { getClientIp } from '../utils/ip.js';
import AppError from '../utils/AppError.js';

const SALT_ROUNDS = 12;
// Comparing against a dummy hash keeps login timing the same whether or not the email exists
const DUMMY_HASH = bcrypt.hashSync('workard-timing-guard', SALT_ROUNDS);

// "ada@example.com" → "a**@example.com" (shown on the "enter code" screen)
function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name[0]}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

function challengeResponse(user, purpose) {
  return {
    requiresOtp: true,
    purpose,
    email: maskEmail(user.email),
    challengeToken: tokenService.signChallengeToken({ userId: user.id, purpose }),
  };
}

// ---------- Session (what the frontend gets after logging in) ----------
export async function buildSession(userId, orgId) {
  const [user, context, organization, organizations] = await Promise.all([
    userModel.findById(userId),
    membershipModel.findContext(userId, orgId),
    organizationModel.findById(orgId),
    membershipModel.listOrganizationsForUser(userId),
  ]);
  if (!user || !context || !organization) return null;

  const employee = context.employee ? await employeeModel.findById(orgId, context.employee.id) : null;

  return {
    user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone },
    organization: { id: organization.id, name: organization.name },
    subscription: context.subscription, // plan, status, features, limits — see utils/subscription.js
    organizations,
    role: context.role,
    permissions: context.permissions,
    employee: employee
      ? {
          id: employee.id,
          firstName: employee.first_name,
          lastName: employee.last_name,
          jobTitle: employee.job_title,
          photoUrl: employee.photo_url,
          branchName: employee.branch_name,
        }
      : null,
  };
}

export async function issueTokens(req, res, userId, orgId) {
  const refreshToken = tokenService.signRefreshToken(userId);
  await refreshTokenModel.create({
    userId,
    orgId,
    tokenHash: tokenService.hashToken(refreshToken),
    userAgent: (req.get('user-agent') || '').slice(0, 255),
    ip: getClientIp(req),
    expiresAt: new Date(Date.now() + env.jwt.refreshDays * 86400000),
  });
  setAuthCookies(res, tokenService.signAccessToken({ userId, orgId }), refreshToken);
}

// ---------- Sign up (step 1): create everything, then email a code ----------
export async function register({ fullName, organizationName, email, phone, password, industry, size, plan }) {
  const existing = await userModel.findByEmail(email);
  if (existing) {
    throw new AppError(409, 'An account with this email already exists', {
      email: existing.email_verified ? 'This email is already registered' : 'This email is registered but not verified — log in to verify it',
    });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const userId = await withTransaction(async (db) => {
    const newUserId = await userModel.create({ fullName, email, phone, passwordHash }, db);
    const orgId = await organizationModel.create({ name: organizationName, industry, size }, db);
    const { ownerRoleId, branchId } = await seedOrganization(orgId, db);
    await membershipModel.create({ userId: newUserId, orgId, roleId: ownerRoleId }, db);
    // The chosen plan, unpaid until the owner pays on Paystack (the app stays locked till then)
    await subscriptionModel.create(orgId, plan, db);

    // The owner is also an employee (so they can clock in, appear in the directory, etc.)
    const [firstName, ...rest] = fullName.trim().split(/\s+/);
    await employeeModel.create(
      orgId,
      {
        userId: newUserId,
        firstName,
        lastName: rest.join(' ') || '-',
        email,
        phone,
        jobTitle: 'Owner',
        branchId,
        startDate: toDateString(),
      },
      db
    );
    await auditModel.log({ orgId, userId: newUserId, action: 'organization.created', details: organizationName }, db);
    return newUserId;
  });

  const user = await userModel.findById(userId);
  await otpService.sendCode(user, 'signup');
  return challengeResponse(user, 'signup');
}

// ---------- Log in (step 1): check password, then email a code ----------
export async function login({ email, password }) {
  const user = await userModel.findByEmail(email);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'Incorrect email or password');

  const organizations = await membershipModel.listOrganizationsForUser(user.id);
  if (!organizations.length) throw new AppError(403, 'Your account is not active in any organisation');

  // Not verified yet (e.g. closed the tab during sign up) → finish verification instead
  const purpose = user.email_verified ? 'login' : 'signup';
  await otpService.sendCode(user, purpose, { reuseRecent: true });
  return challengeResponse(user, purpose);
}

// ---------- Step 2 for sign up & log in: check the code, then log in ----------
export async function verifyOtp(req, res, { challengeToken, code }) {
  const challenge = tokenService.verifyChallengeToken(challengeToken, ['signup', 'login']);
  if (!challenge) throw new AppError(401, 'This verification has expired. Please log in again.');

  await otpService.verifyCode(challenge.userId, challenge.purpose, code);
  if (challenge.purpose === 'signup') await userModel.markEmailVerified(challenge.userId);

  const [firstOrg] = await membershipModel.listOrganizationsForUser(challenge.userId);
  if (!firstOrg) throw new AppError(403, 'Your account is not active in any organisation');

  await userModel.touchLastLogin(challenge.userId, new Date());
  await issueTokens(req, res, challenge.userId, firstOrg.id);
  return buildSession(challenge.userId, firstOrg.id);
}

export async function resendOtp({ challengeToken }) {
  const challenge = tokenService.verifyChallengeToken(challengeToken, ['signup', 'login', 'reset']);
  if (!challenge) throw new AppError(401, 'This verification has expired. Please start again.');
  const user = await userModel.findById(challenge.userId);
  if (user) await otpService.sendCode(user, challenge.purpose);
  return { message: 'A new code has been sent' };
}

// ---------- Forgot / reset password ----------
// Always answers the same way, so nobody can use it to check which emails have accounts.
export async function forgotPassword({ email }) {
  const user = await userModel.findByEmail(email);
  if (user) await otpService.sendCode(user, 'reset', { reuseRecent: true });
  return {
    requiresOtp: true,
    purpose: 'reset',
    email: maskEmail(email),
    challengeToken: tokenService.signChallengeToken({ userId: user ? user.id : 0, purpose: 'reset' }),
  };
}

export async function resetPassword({ challengeToken, code, password }) {
  const challenge = tokenService.verifyChallengeToken(challengeToken, ['reset']);
  if (!challenge) throw new AppError(401, 'This reset has expired. Please start again.');
  if (!challenge.userId) throw new AppError(400, 'That code is incorrect', { code: 'Incorrect code' });

  await otpService.verifyCode(challenge.userId, 'reset', code);
  await userModel.updatePassword(challenge.userId, await bcrypt.hash(password, SALT_ROUNDS));
  await userModel.markEmailVerified(challenge.userId); // they proved they own the email
  await refreshTokenModel.revokeAllForUser(challenge.userId, new Date()); // log out everywhere
  return { message: 'Password updated. You can now log in.' };
}

// ---------- Refresh: swap an old refresh token for a new pair ----------
export async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new AppError(401, 'Not authenticated');

  const fail = () => {
    clearAuthCookies(res);
    return new AppError(401, 'Session expired');
  };

  let payload;
  try {
    payload = tokenService.verifyRefreshToken(token);
  } catch {
    throw fail();
  }

  const now = new Date();
  const stored = await refreshTokenModel.findByHash(tokenService.hashToken(token));
  if (!stored || new Date(stored.expires_at.replace(' ', 'T')) < now) throw fail();

  // A token that was already used is being used again → probably stolen. Log out everywhere.
  if (stored.revoked_at) {
    await refreshTokenModel.revokeAllForUser(stored.user_id, now);
    throw fail();
  }

  await refreshTokenModel.revoke(stored.id, now);
  const userId = Number(payload.sub);
  const session = await buildSession(userId, stored.organization_id);
  if (!session) throw fail();

  await issueTokens(req, res, userId, stored.organization_id);
  return session;
}

export async function logout(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await refreshTokenModel.revokeByHash(tokenService.hashToken(token), new Date());
  clearAuthCookies(res);
  return { message: 'Logged out' };
}

// Move to another organisation this user belongs to
export async function switchOrganization(req, res, organizationId) {
  const membership = await membershipModel.findByUserAndOrg(req.auth.userId, organizationId);
  if (!membership || membership.status !== 'active') throw new AppError(403, 'You are not a member of that organisation');

  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await refreshTokenModel.revokeByHash(tokenService.hashToken(token), new Date());
  await issueTokens(req, res, req.auth.userId, organizationId);
  return buildSession(req.auth.userId, organizationId);
}
