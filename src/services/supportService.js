import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import * as supportGrantModel from '../models/supportGrantModel.js';
import * as adminModel from '../models/adminModel.js';
import * as platformModel from '../models/platformModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { notify } from './notificationService.js';
import { PERMISSION_KEYS } from '../config/permissions.js';
import { describeSubscription } from '../utils/subscription.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../utils/cookies.js';
import AppError from '../utils/AppError.js';

// ============================================================
// SUPPORT ACCESS — Workard can only look inside a company when its OWNER allows it.
//   Owner: Settings → "Workard support access" → open for 1 / 4 / 24 / 72 hours (or close it).
//   Super admin: Companies → the company → "Open (read-only)" — only while it's open.
//   The visit is READ-ONLY (anything but GET is refused), shows a banner, ends when the
//   access ends, and is written to the company's activity log + the owner's bell.
// ============================================================

export const HOURS = [1, 4, 24, 72];
const MAX_SESSION_HOURS = 2;

const ownerUserIds = async (orgId) => {
  const [rows] = await pool.query(
    `SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
      WHERE m.organization_id = ? AND r.is_owner = 1 AND m.status = 'active'`,
    [orgId]
  );
  return rows.map((r) => r.user_id);
};

// ---------- Owner side ----------
export async function status(auth) {
  const [active, history] = await Promise.all([supportGrantModel.findActive(auth.orgId), supportGrantModel.list(auth.orgId)]);
  const [visits] = await pool.query(
    `SELECT a.created_at, a.details, u.full_name AS who FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.organization_id = ? AND a.action = 'support.opened' ORDER BY a.id DESC LIMIT 20`,
    [auth.orgId]
  );
  return { active, history, visits, hours: HOURS };
}

export async function grant(auth, { hours, reason }) {
  if (!HOURS.includes(hours)) throw new AppError(422, 'Choose 1, 4, 24 or 72 hours');
  await supportGrantModel.revokeAll(auth.orgId); // one at a time
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await supportGrantModel.create(auth.orgId, { grantedBy: auth.userId, reason, expiresAt });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'support.granted', details: `${hours} hour${hours === 1 ? '' : 's'}${reason ? ` — ${reason}` : ''}` });
  return status(auth);
}

export async function revoke(auth) {
  await supportGrantModel.revokeAll(auth.orgId);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'support.revoked' });
  return status(auth);
}

// ---------- Super admin side ----------
// Opens the company's app in this browser, read-only, until the access ends (at most 2 hours)
export async function openSession(admin, res, orgId) {
  const company = await platformModel.findCompany(orgId);
  if (!company) throw new AppError(404, 'Company not found');
  const grantRow = await supportGrantModel.findActive(orgId);
  if (!grantRow) throw new AppError(403, 'The owner hasn’t opened support access. Ask them to switch it on in Settings → Workard support access.');

  const until = Math.min(new Date(grantRow.expires_at.replace(' ', 'T')).getTime(), Date.now() + MAX_SESSION_HOURS * 3600_000);
  const seconds = Math.max(60, Math.floor((until - Date.now()) / 1000));
  const token = jwt.sign({ sub: String(admin.userId), oid: Number(orgId), sup: grantRow.id, typ: 'access' }, env.jwt.accessSecret, { expiresIn: seconds });

  const base = { httpOnly: true, secure: env.isProd || env.cookieSameSite === 'none', sameSite: env.cookieSameSite };
  res.cookie(ACCESS_COOKIE, token, { ...base, path: '/', maxAge: seconds * 1000 });
  // No refresh token: when the time is up, the visit simply ends
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });

  await auditModel.log({ orgId: Number(orgId), userId: admin.userId, action: 'support.opened', details: `${admin.userName} (Workard support), read-only` });
  await notify(Number(orgId), await ownerUserIds(orgId), {
    type: 'support.opened',
    title: `Workard support (${admin.userName}) is looking at your account`,
    body: 'Read-only, using the access you gave. You can close it any time in Settings.',
    link: '/settings?tab=support',
  });
  await adminModel.log(admin.userId, 'support.opened', { targetType: 'company', targetId: Number(orgId) });
  return { endsAt: new Date(until).toISOString() };
}

// Used by requireAuth for a support visit's token: what the visitor may see
export async function contextFor(payload) {
  const adminUserId = Number(payload.sub);
  const orgId = Number(payload.oid);
  const [grantRow, admin] = await Promise.all([supportGrantModel.findById(payload.sup), adminModel.findByUserId(adminUserId)]);
  const open = grantRow && grantRow.organization_id === orgId && !grantRow.revoked_at && new Date(grantRow.expires_at.replace(' ', 'T')) > new Date();
  if (!open || !admin || admin.locked_at) return null;

  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE organization_id = ?', [orgId]);
  return {
    userId: adminUserId,
    userName: `${admin.full_name} (Workard support)`,
    orgId,
    role: { id: null, name: 'Workard support (read-only)', isOwner: false },
    permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'all'])),
    employee: null,
    subscription: describeSubscription(sub || null),
    support: { grantId: grantRow.id, expiresAt: grantRow.expires_at },
  };
}

// What /api/auth/me returns during a support visit
export async function sessionFor(auth) {
  const organization = await organizationModel.findById(auth.orgId);
  const admin = await adminModel.findByUserId(auth.userId);
  return {
    user: { id: auth.userId, fullName: admin.full_name, email: admin.email, phone: null },
    organization: { id: organization.id, name: organization.name },
    subscription: auth.subscription,
    organizations: [],
    role: auth.role,
    permissions: auth.permissions,
    employee: null,
    support: { expiresAt: auth.support.expiresAt },
  };
}
