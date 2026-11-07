import { env } from '../config/env.js';
import { PLANS, INTERVALS, PLAN_ORDER } from '../config/plans.js';
import * as platformModel from '../models/platformModel.js';
import * as adminModel from '../models/adminModel.js';
import * as demoRequestModel from '../models/demoRequestModel.js';
import * as supportGrantModel from '../models/supportGrantModel.js';
import * as refreshTokenModel from '../models/refreshTokenModel.js';
import * as auditModel from '../models/auditModel.js';
import { notify } from './notificationService.js';
import {
  sendEmail,
  companySuspendedEmail,
  companyRestoredEmail,
  platformAnnouncementEmail,
  demoRequestEmail,
  passwordResetNudgeEmail,
} from './emailService.js';
import { describeSubscription } from '../utils/subscription.js';
import { toDateString, addDays } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

// ============================================================
// SUPER ADMIN — running Workard the business.
// Companies, users, payments, announcements to owners, demo requests.
// Admins see account details and COUNTS, never a company's own records;
// looking inside needs the owner's permission (supportService).
// Every change is written to the admin log (and to the company's own
// activity log when it affects the company).
// ============================================================

const firstName = (name) => String(name || '').split(' ')[0] || 'there';

function subscriptionOf(row) {
  if (!row.plan && !row.sub_status) return describeSubscription(null);
  return describeSubscription({
    plan: row.plan,
    status: row.sub_status,
    current_period_end: row.current_period_end ? String(row.current_period_end).slice(0, 10) : null,
    is_legacy: row.is_legacy,
    created_at: row.sub_created_at,
  });
}

// One label per company for lists and filters
export function companyStatus(row, sub = subscriptionOf(row)) {
  if (row.suspended_at) return 'suspended';
  if (sub.isLegacy) return 'exempt';
  return sub.status; // free | trial | trial_ended | active | grace | expired
}

function companySummary(row) {
  const sub = subscriptionOf(row);
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    size: row.size,
    createdAt: row.created_at,
    owner: row.owner_user_id ? { id: row.owner_user_id, name: row.owner_name, email: row.owner_email, phone: row.owner_phone } : null,
    employees: Number(row.employees),
    lastActive: row.last_active,
    status: companyStatus(row, sub),
    plan: sub.plan,
    planName: sub.planName,
    interval: row.billing_interval,
    periodEnd: sub.periodEnd,
    daysLeft: sub.daysLeft,
    autoRenew: Boolean(row.auto_renew),
    hasCard: Boolean(row.has_card),
    renewalProblem: row.renewal_problem,
    nextPlan: row.next_plan,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
  };
}

// ---------- Overview ----------
const monthlyValue = (c) => {
  if (!['active', 'grace'].includes(c.status) || !PLANS[c.plan]) return 0;
  return c.interval === 'yearly' ? Math.round(PLANS[c.plan].prices.yearly / 12) : PLANS[c.plan].prices.monthly;
};

export async function overview() {
  const [rows, signups, revenue, totals, failed30, payments] = await Promise.all([
    platformModel.listCompanies(),
    platformModel.signupsByWeek(12),
    platformModel.revenueByMonth(12),
    platformModel.totals(),
    platformModel.failedPaymentsSince(30),
    platformModel.listPayments({ status: 'paid', limit: 5 }),
  ]);
  const companies = rows.map(companySummary);
  const byStatus = {};
  for (const c of companies) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  const byPlan = {};
  for (const c of companies.filter((x) => ['active', 'grace'].includes(x.status))) byPlan[c.plan] = (byPlan[c.plan] || 0) + 1;

  return {
    totals: { ...totals, failedPayments30: failed30 },
    byStatus,
    byPlan,
    // What paying companies are worth per month at today's prices (yearly ÷ 12)
    monthlyRevenueKobo: companies.reduce((sum, c) => sum + monthlyValue(c), 0),
    signupsByWeek: signups,
    revenueByMonth: revenue,
    trialsEndingSoon: companies.filter((c) => c.status === 'trial' && c.daysLeft !== null && c.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 10),
    renewalProblems: companies.filter((c) => c.renewalProblem).slice(0, 10),
    newest: companies.slice(0, 6),
    latestPayments: payments.rows,
  };
}

// ---------- Companies ----------
export async function listCompanies({ search, status, page = 1, pageSize = 50 }) {
  const all = (await platformModel.listCompanies({ search })).map(companySummary);
  const counts = {};
  for (const c of all) counts[c.status] = (counts[c.status] || 0) + 1;
  const filtered = status ? all.filter((c) => c.status === status) : all;
  const start = (page - 1) * pageSize;
  return { companies: filtered.slice(start, start + pageSize), total: filtered.length, page, pages: Math.max(1, Math.ceil(filtered.length / pageSize)), counts };
}

async function companyOrFail(id) {
  const row = await platformModel.findCompany(id);
  if (!row) throw new AppError(404, 'Company not found');
  return row;
}

export async function getCompany(id) {
  const row = await companyOrFail(id);
  const [usage, payments, grant, log] = await Promise.all([
    platformModel.usage(row.id),
    platformModel.listPayments({ orgId: row.id, limit: 20 }),
    supportGrantModel.findActive(row.id),
    adminModel.listLog({ limit: 200 }),
  ]);
  return {
    ...companySummary(row),
    usage,
    payments: payments.rows,
    paidTotalKobo: payments.paidKobo,
    supportAccess: grant ? { expiresAt: grant.expires_at, grantedBy: grant.granted_by_name, reason: grant.reason } : null,
    adminLog: log.rows.filter((l) => l.target_type === 'company' && l.target_id === row.id).slice(0, 20),
  };
}

async function recordCompanyChange(admin, orgId, action, details) {
  await adminModel.log(admin.userId, action, { targetType: 'company', targetId: orgId, details });
  // The company sees it in its own activity log too
  await auditModel.log({ orgId, userId: admin.userId, action: `workard.${action.split('.')[1]}`, details: `Workard: ${details}` });
}

// More trial days (only before they've paid)
export async function extendTrial(admin, id, days) {
  const row = await companyOrFail(id);
  const sub = subscriptionOf(row);
  if (!['trial', 'trial_ended'].includes(sub.status)) throw new AppError(409, 'Only a company on a trial (or whose trial ended) can get more trial days');
  const today = toDateString();
  const from = sub.periodEnd && sub.periodEnd >= today ? sub.periodEnd : addDays(today, -1);
  const end = addDays(from, days);
  await platformModel.updateSubscription(row.id, { current_period_end: end });
  await recordCompanyChange(admin, row.id, 'company.trial_extended', `trial extended by ${days} day${days === 1 ? '' : 's'}, to ${end}`);
  return getCompany(row.id);
}

// Put a company on a plan until a date, without payment (a deal, a refund, free months).
// Paystack isn't touched: a company with a saved card keeps its Paystack schedule.
export async function setPlan(admin, id, { plan, interval, periodEnd }) {
  const row = await companyOrFail(id);
  if (!PLAN_ORDER.includes(plan) || !INTERVALS.includes(interval)) throw new AppError(422, 'Choose a plan and how often they pay');
  if (periodEnd < toDateString()) throw new AppError(422, 'The end date must be today or later', { periodEnd: 'Today or later' });
  await platformModel.updateSubscription(row.id, {
    plan,
    status: 'active',
    billing_interval: interval,
    current_period_start: row.current_period_start || toDateString(),
    current_period_end: periodEnd,
    renewal_problem: null,
  });
  await recordCompanyChange(admin, row.id, 'company.plan_set', `${PLANS[plan].name} (${interval}) until ${periodEnd}`);
  return getCompany(row.id);
}

// Exempt = everything, never billed (like the companies from before plans existed)
export async function setExempt(admin, id, exempt) {
  const row = await companyOrFail(id);
  await platformModel.updateSubscription(row.id, { is_legacy: exempt ? 1 : 0 });
  await recordCompanyChange(admin, row.id, exempt ? 'company.exempted' : 'company.unexempted', exempt ? 'free of charge (no billing)' : 'billed normally again');
  return getCompany(row.id);
}

export async function suspend(admin, id, reason) {
  const row = await companyOrFail(id);
  if (row.suspended_at) throw new AppError(409, 'Already suspended');
  await platformModel.setSuspended(row.id, reason);
  await supportGrantModel.revokeAll(row.id);
  await recordCompanyChange(admin, row.id, 'company.suspended', reason);
  if (row.owner_email) {
    await sendEmail({ to: row.owner_email, ...companySuspendedEmail({ firstName: firstName(row.owner_name), organizationName: row.name, reason }) }).catch(() => {});
  }
  return getCompany(row.id);
}

export async function restore(admin, id) {
  const row = await companyOrFail(id);
  if (!row.suspended_at) throw new AppError(409, 'Not suspended');
  await platformModel.setSuspended(row.id, null);
  await recordCompanyChange(admin, row.id, 'company.restored', 'suspension lifted');
  if (row.owner_email) {
    await sendEmail({ to: row.owner_email, ...companyRestoredEmail({ firstName: firstName(row.owner_name), organizationName: row.name, link: `${env.clientUrls[0]}/login` }) }).catch(() => {});
  }
  return getCompany(row.id);
}

// ---------- Users ----------
export const listUsers = ({ search }) => platformModel.listUsers({ search, limit: search ? 100 : 50 });

async function userOrFail(id) {
  const user = await platformModel.findUser(id);
  if (!user) throw new AppError(404, 'User not found');
  return user;
}

export async function setUserLocked(admin, id, locked) {
  const user = await userOrFail(id);
  if (locked && Number(id) === admin.userId) throw new AppError(409, 'You can’t lock yourself');
  await platformModel.setLocked(user.id, locked);
  if (locked) await refreshTokenModel.revokeAllForUser(user.id, new Date()); // logged out everywhere
  await adminModel.log(admin.userId, locked ? 'user.locked' : 'user.unlocked', { targetType: 'user', targetId: user.id, details: user.email });
  return { id: user.id, locked };
}

export async function sendPasswordReset(admin, id) {
  const user = await userOrFail(id);
  const link = `${env.clientUrls[0]}/forgot-password?email=${encodeURIComponent(user.email)}`;
  await sendEmail({ to: user.email, ...passwordResetNudgeEmail({ firstName: firstName(user.full_name), link }) });
  await adminModel.log(admin.userId, 'user.reset_sent', { targetType: 'user', targetId: user.id, details: user.email });
  return { message: `Reset link sent to ${user.email}` };
}

// ---------- Payments to Workard ----------
export const listPayments = ({ status, page = 1 }) => platformModel.listPayments({ status, limit: 50, offset: (page - 1) * 50 });

// ---------- Announcements to company owners ----------
export async function sendAnnouncement(admin, { title, body, audience, sendEmail: withEmail }) {
  const owners = (await platformModel.owners()).filter((o) => {
    const sub = subscriptionOf(o);
    if (audience === 'trial') return ['trial', 'trial_ended'].includes(sub.status);
    if (audience === 'paying') return ['active', 'grace'].includes(sub.status) && !sub.isLegacy;
    return true;
  });
  for (const o of owners) {
    await notify(o.organization_id, [o.user_id], { type: 'workard.announcement', title: `Workard: ${title}`, body: body.slice(0, 480), link: null });
    if (withEmail) {
      await sendEmail({ to: o.email, ...platformAnnouncementEmail({ firstName: firstName(o.full_name), title, body, link: env.clientUrls[0] }) }).catch((err) =>
        console.error('Announcement email failed:', err.message)
      );
    }
  }
  const id = await demoRequestModel.createAnnouncement({ title, body, audience, emailed: withEmail, sentTo: owners.length, createdBy: admin.userId });
  await adminModel.log(admin.userId, 'announcement.sent', { details: `${title} → ${owners.length} owner(s)` });
  return { id, sentTo: owners.length };
}

export const listAnnouncements = () => demoRequestModel.listAnnouncements();

// ---------- Demo requests (from the website) ----------
export async function createDemoRequest(data) {
  if ((await demoRequestModel.countRecentFromEmail(data.email)) >= 3) {
    return { message: 'Thanks — we already have your request and will be in touch soon.' };
  }
  await demoRequestModel.create(data);
  // Tell every super admin
  const admins = await adminModel.list();
  const link = `${env.clientUrls[0]}/admin/demos`;
  for (const a of admins) {
    await sendEmail({
      to: a.email,
      ...demoRequestEmail({ name: data.fullName, email: data.email, phone: data.phone, company: data.company, size: data.companySize, message: data.message, link }),
    }).catch(() => {});
  }
  return { message: 'Thanks! We’ll be in touch within one working day to set up your demo.' };
}

export const listDemoRequests = ({ status }) => demoRequestModel.list({ status });

export async function updateDemoRequest(admin, id, data) {
  const row = await demoRequestModel.findById(id);
  if (!row) throw new AppError(404, 'Request not found');
  await demoRequestModel.update(id, data);
  if (data.status && data.status !== row.status) await adminModel.log(admin.userId, 'demo.updated', { details: `${row.email}: ${data.status}` });
  return demoRequestModel.findById(id);
}

// ---------- Admins & log ----------
export const listAdmins = () => adminModel.list();
export const listLog = ({ page = 1 }) => adminModel.listLog({ limit: 50, offset: (page - 1) * 50 });
