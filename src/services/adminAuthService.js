import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import * as userModel from '../models/userModel.js';
import * as adminModel from '../models/adminModel.js';
import * as otpService from './otpService.js';
import * as tokenService from './tokenService.js';
import { sendEmail, adminInviteEmail } from './emailService.js';
import { withTransaction } from '../config/db.js';
import AppError from '../utils/AppError.js';

// ============================================================
// SUPER ADMIN LOG-IN — separate from company log-ins.
//   password → 6-digit code by email (purpose "admin") → an 8-hour admin session
//   in its own cookie (wk_admin, only sent to /api/admin). A super admin who also
//   works in a company keeps both sessions side by side.
// ============================================================

export const ADMIN_COOKIE = 'wk_admin';
const SESSION_HOURS = 8;
const SETUP_DAYS = 3;
const SALT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('workard-admin-timing-guard', SALT_ROUNDS);

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd || env.cookieSameSite === 'none',
    sameSite: env.cookieSameSite,
    path: '/api/admin',
  };
}

export function signAdminToken(userId) {
  return jwt.sign({ sub: String(userId), typ: 'admin' }, env.jwt.accessSecret, { expiresIn: `${SESSION_HOURS}h` });
}

export function verifyAdminToken(token) {
  const payload = jwt.verify(token, env.jwt.accessSecret);
  if (payload.typ !== 'admin') throw new Error('Wrong token type');
  return Number(payload.sub);
}

const mask = (email) => {
  const [name, domain] = email.split('@');
  return `${name[0]}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
};

// Step 1: email + password. Same answer whether the email exists or not.
export async function login({ email, password }) {
  const user = await userModel.findByEmail(email);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !(await adminModel.isAdmin(user.id))) throw new AppError(401, 'Incorrect email or password');
  if (user.locked_at) throw new AppError(403, 'This account is locked');
  await otpService.sendCode(user, 'admin', { reuseRecent: true });
  return {
    requiresOtp: true,
    purpose: 'admin',
    email: mask(user.email),
    challengeToken: tokenService.signChallengeToken({ userId: user.id, purpose: 'admin' }),
  };
}

// Step 2: the code from the email
export async function verify(res, { challengeToken, code }) {
  const challenge = tokenService.verifyChallengeToken(challengeToken, ['admin']);
  if (!challenge) throw new AppError(401, 'This verification has expired. Please log in again.');
  await otpService.verifyCode(challenge.userId, 'admin', code);
  if (!(await adminModel.isAdmin(challenge.userId))) throw new AppError(401, 'Incorrect email or password');
  await userModel.touchLastLogin(challenge.userId, new Date());
  res.cookie(ADMIN_COOKIE, signAdminToken(challenge.userId), { ...cookieOptions(), maxAge: SESSION_HOURS * 3600 * 1000 });
  return session(challenge.userId);
}

export async function resend({ challengeToken }) {
  const challenge = tokenService.verifyChallengeToken(challengeToken, ['admin']);
  if (!challenge) throw new AppError(401, 'This verification has expired. Please log in again.');
  const user = await userModel.findById(challenge.userId);
  if (user) await otpService.sendCode(user, 'admin');
  return { message: 'A new code has been sent' };
}

export function logout(res) {
  res.clearCookie(ADMIN_COOKIE, cookieOptions());
  return { message: 'Logged out' };
}

export async function session(userId) {
  const admin = await adminModel.findByUserId(userId);
  if (!admin) throw new AppError(401, 'Not an admin');
  return { admin: { id: admin.user_id, fullName: admin.full_name, email: admin.email } };
}

// ---------- Adding super admins ----------
// Existing Workard user → becomes an admin and keeps their password.
// New person → an account is made and they get a "set your password" link (3 days).
export async function addAdmin(by, { fullName, email }) {
  const existing = await userModel.findByEmail(email);
  if (existing && (await adminModel.isAdmin(existing.id))) throw new AppError(409, 'They’re already a super admin', { email: 'Already a super admin' });

  const token = tokenService.randomToken();
  const expires = new Date(Date.now() + SETUP_DAYS * 86400_000);
  const userId = await withTransaction(async (db) => {
    let id = existing?.id;
    if (!id) {
      // An unguessable password nobody knows — replaced when they use the link
      const passwordHash = await bcrypt.hash(tokenService.randomToken(), SALT_ROUNDS);
      id = await userModel.create({ fullName, email, phone: null, passwordHash }, db);
    }
    await adminModel.add(id, by.userId, existing ? {} : { setupTokenHash: tokenService.hashToken(token), setupExpiresAt: expires }, db);
    return id;
  });

  const link = `${env.clientUrls[0]}/admin/setup/${token}`;
  const firstName = (existing?.full_name || fullName).split(' ')[0];
  if (existing) {
    await sendEmail({
      to: email,
      subject: 'You’re now a Workard super admin',
      text: `Hi ${firstName}, ${by.userName} added you as a Workard super admin. Log in at ${env.clientUrls[0]}/admin with your usual Workard password.`,
      html: `<p>Hi ${firstName},</p><p>${by.userName} added you as a Workard super admin. Log in at <a href="${env.clientUrls[0]}/admin">${env.clientUrls[0]}/admin</a> with your usual Workard password.</p>`,
    });
  } else {
    await sendEmail({ to: email, ...adminInviteEmail({ firstName, invitedBy: by.userName, link }) });
  }
  await adminModel.log(by.userId, 'admin.added', { targetType: 'user', targetId: userId, details: email });
  return { userId, setupLink: existing ? null : link };
}

// The "set your password" page
export async function checkSetup(token) {
  const row = await adminModel.findBySetupToken(tokenService.hashToken(token));
  if (!row) throw new AppError(404, 'This link has expired or was already used. Ask another super admin to add you again.');
  return { email: row.email, fullName: row.full_name };
}

export async function completeSetup(token, password) {
  const row = await adminModel.findBySetupToken(tokenService.hashToken(token));
  if (!row) throw new AppError(404, 'This link has expired or was already used. Ask another super admin to add you again.');
  await userModel.updatePassword(row.user_id, await bcrypt.hash(password, SALT_ROUNDS));
  await userModel.markEmailVerified(row.user_id); // the link went to their inbox
  await adminModel.clearSetupToken(row.user_id);
  await adminModel.log(row.user_id, 'admin.setup_done');
  return { message: 'Password set. You can now log in.' };
}

export async function removeAdmin(by, userId) {
  if (Number(userId) === by.userId) throw new AppError(409, 'You can’t remove yourself — ask another super admin');
  if (!(await adminModel.isAdmin(userId))) throw new AppError(404, 'Not a super admin');
  if ((await adminModel.count()) <= 1) throw new AppError(409, 'Workard needs at least one super admin');
  await adminModel.remove(userId);
  await adminModel.log(by.userId, 'admin.removed', { targetType: 'user', targetId: Number(userId) });
}
