import crypto from 'node:crypto';
import * as subscriptionModel from '../models/subscriptionModel.js';
import * as userModel from '../models/userModel.js';
import * as auditModel from '../models/auditModel.js';
import * as paystackService from './paystackService.js';
import { notify } from './notificationService.js';
import { pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { PLANS, PLAN_ORDER, INTERVALS, FEATURE_NAMES, GRACE_DAYS, billing } from '../config/plans.js';
import { describeSubscription, daysBetween, periodEnd } from '../utils/subscription.js';
import { toDateString, addDays, formatDateLong } from '../utils/dates.js';
import { formatNaira } from '../utils/money.js';
import AppError from '../utils/AppError.js';

// ============================================================
// PLANS & BILLING — organisations pay Workard monthly or yearly, by card,
// and Paystack charges the card again automatically at the end of each period.
//
//   sign up → free trial (TRIAL_DAYS) → owner pays on Paystack (first payment)
//     → we ASK PAYSTACK whether it was paid (never trust the browser)
//     → plan active for a month / year, and Paystack has subscribed the card
//   each renewal: Paystack charges the card → webhook "charge.success" → next period
//   card declined: webhook "invoice.payment_failed" → owner told; GRACE_DAYS later the app locks
//   BILLING_ENABLED=false → no trial, no payments: everyone has everything for free
//
// Changing plan:
//   bigger plan, same interval → pay the difference for the days left now, switch straight away
//   anything else (smaller plan, monthly ↔ yearly) → no payment now; starts with the next period
//
// Applying a payment is safe to repeat: rows are locked, references are unique.
// ============================================================

const rank = (planId) => PLAN_ORDER.indexOf(planId);

function requireKey() {
  if (!env.billingPaystackKey) throw new AppError(503, 'Payments are not set up yet (PAYSTACK_SECRET_KEY is missing on the server)');
  return env.billingPaystackKey;
}

function requireOwner(auth) {
  if (!auth.role.isOwner) throw new AppError(403, 'Only the owner of the organisation can manage the plan and payments');
}

const intervalOf = (sub) => sub.billing_interval || 'yearly'; // paid before monthly existed = yearly

// What would the owner do / pay right now to be on `planId`, paid `interval`?
//   trial / trial ended / expired / grace → pay for a new period, full price          (kind new / renewal)
//   active, bigger plan, same interval    → pay the difference for the days left     (kind upgrade)
//   active, same plan and interval        → nothing (it renews automatically)
//   active, anything else                 → no payment now, starts next period       (kind scheduled)
export function quote(sub, planId, interval, today = toDateString()) {
  const plan = PLANS[planId];
  const price = plan.prices[interval];
  const desc = describeSubscription(sub, today);
  if (desc.isLegacy) return { allowed: false, reason: 'Your organisation already has full access.' };
  if (desc.status === 'free') return { allowed: false, reason: 'Workard is free during early access — nothing to pay yet.' };

  if (['trial', 'trial_ended', 'expired', 'grace'].includes(desc.status)) {
    return { allowed: true, kind: desc.status.startsWith('trial') ? 'new' : 'renewal', amountKobo: price };
  }

  const currentInterval = intervalOf(sub);
  if (planId === desc.plan && interval === currentInterval) {
    return { allowed: false, current: true, reason: `Your plan renews automatically on ${formatDateLong(addDays(sub.current_period_end, 1))}.` };
  }
  if (interval === currentInterval && rank(planId) > rank(desc.plan)) {
    const daysLeft = daysBetween(today, sub.current_period_end) + 1; // today counts
    const periodDays = daysBetween(sub.current_period_start, sub.current_period_end) + 1;
    const difference = price - PLANS[desc.plan].prices[interval];
    // rounded to the naira, never less than ₦100
    const amountKobo = Math.max(10_000, Math.round((difference * daysLeft) / periodDays / 100) * 100);
    return { allowed: true, kind: 'upgrade', amountKobo, daysLeft };
  }
  return { allowed: true, kind: 'scheduled', amountKobo: 0, startsOn: addDays(sub.current_period_end, 1), nextAmountKobo: price };
}

// ---------- What the Billing page shows ----------
export async function getBilling(auth) {
  const sub = await subscriptionModel.find(auth.orgId);
  const subscription = describeSubscription(sub);
  // Staff only learn whether they can use the app — prices and payments are the owner's business
  if (!auth.role.isOwner) {
    return { isOwner: false, subscription: { status: subscription.status, usable: subscription.usable, planName: subscription.planName } };
  }
  const paid = sub && !sub.is_legacy && sub.status === 'active';
  return {
    isOwner: true,
    subscription: {
      ...subscription,
      interval: paid ? intervalOf(sub) : null,
      autoRenew: paid ? Boolean(sub.auto_renew) && Boolean(sub.paystack_subscription_code) : false,
      renewalProblem: sub?.renewal_problem || null,
      nextPlan: sub?.next_plan || null,
      nextInterval: sub?.next_interval || null,
      canManageCard: Boolean(sub?.paystack_subscription_code),
    },
    plans: PLAN_ORDER.map((id) => ({
      ...publicPlan(PLANS[id]),
      quotes: sub ? Object.fromEntries(INTERVALS.map((i) => [i, quote(sub, id, i)])) : null,
    })),
    payments: await subscriptionModel.listPayments(auth.orgId),
  };
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    prices: { ...plan.prices, yearlyPerMonth: Math.round(plan.prices.yearly / 12) },
    features: plan.features.map((f) => ({ id: f, name: FEATURE_NAMES[f] })),
    maxEmployees: plan.maxEmployees,
    maxBranches: plan.maxBranches,
    customRoles: plan.customRoles,
  };
}

export function listPlans() {
  return PLAN_ORDER.map((id) => publicPlan(PLANS[id]));
}

// Is billing switched on? (the sign-up page hides the plan picker when it isn't)
export function getConfig() {
  return { enabled: billing.enabled, trialDays: billing.trialDays };
}

// The Paystack plan for this plan + interval + price — created on Paystack the first time it's needed
async function planCodeFor(planId, interval) {
  const amountKobo = PLANS[planId].prices[interval];
  const existing = await subscriptionModel.findPlanCode(planId, interval, amountKobo);
  if (existing) return existing;
  const code = await paystackService.createPlan(requireKey(), {
    name: `Workard ${PLANS[planId].name} (${interval}) ${formatNaira(amountKobo)}`,
    interval,
    amountKobo,
  });
  await subscriptionModel.savePlanCode(planId, interval, amountKobo, code);
  return (await subscriptionModel.findPlanCode(planId, interval, amountKobo)) || code;
}

// ---------- Step 1: start a payment ----------
export async function checkout(auth, { plan: planId, interval }) {
  requireOwner(auth);
  const key = requireKey();
  const sub = await subscriptionModel.find(auth.orgId);
  if (!sub) throw new AppError(409, 'Your organisation already has full access.');

  const q = quote(sub, planId, interval);
  if (!q.allowed) throw new AppError(409, q.reason);
  if (q.kind === 'scheduled') throw new AppError(409, 'Nothing to pay now — this change starts with your next period.');

  const reference = `wkbill_${crypto.randomBytes(12).toString('hex')}`;
  const paymentId = await subscriptionModel.createPayment({
    orgId: auth.orgId,
    reference,
    plan: planId,
    kind: q.kind,
    interval,
    amountKobo: q.amountKobo,
    createdBy: auth.userId,
  });

  const user = await userModel.findById(auth.userId);
  const { authorizationUrl } = await paystackService.initializeTransaction(key, {
    email: user.email,
    amountKobo: q.amountKobo,
    reference,
    callbackUrl: `${env.clientUrls[0]}/billing/callback`,
    metadata: { organizationId: auth.orgId, plan: planId, interval, kind: q.kind },
    // A new period also subscribes the card, so Paystack renews it automatically.
    // (An upgrade is a one-off top-up; the subscription is moved to the new plan after.)
    planCode: q.kind === 'upgrade' ? null : await planCodeFor(planId, interval),
  });
  await subscriptionModel.setAuthorizationUrl(paymentId, authorizationUrl);
  return { reference, authorizationUrl, amountKobo: q.amountKobo, kind: q.kind };
}

// ---------- Step 2: confirm with Paystack, then switch the plan on ----------
// Called by the callback page (orgId = the owner's organisation) and by the webhook (orgId = null).
export async function verifyPayment(reference, orgId = null) {
  const payment = await subscriptionModel.findPaymentByReference(reference);
  if (!payment || (orgId && payment.organization_id !== orgId)) throw new AppError(404, 'Payment not found');
  if (payment.status === 'paid') return { status: 'paid', plan: payment.plan };

  const tx = await paystackService.verifyTransaction(requireKey(), reference);
  if (tx.status !== 'success') {
    if (['failed', 'abandoned', 'reversed'].includes(tx.status)) await subscriptionModel.markPaymentFailed(payment.id);
    return { status: tx.status === 'abandoned' ? 'failed' : tx.status };
  }
  // The amount must match what we asked for (stops a tampered or partial payment counting)
  if (tx.amountKobo !== Number(payment.amount_kobo) || tx.currency !== 'NGN') {
    console.error(`Billing: amount mismatch for ${reference}: got ${tx.amountKobo} ${tx.currency}`);
    throw new AppError(400, 'The amount paid does not match. Please contact Workard support.');
  }

  const applied = await withTransaction(async (db) => {
    const locked = await subscriptionModel.lockPaymentByReference(reference, db);
    if (locked.status === 'paid') return false; // the webhook (or another tab) got here first
    const sub = await subscriptionModel.lock(locked.organization_id, db);
    const interval = locked.billing_interval || 'yearly';

    const today = toDateString();
    let start = today;
    let end = periodEnd(today, interval);
    if (locked.kind === 'upgrade' && sub.current_period_end >= today) {
      // same period, bigger plan
      start = sub.current_period_start;
      end = sub.current_period_end;
    }

    await subscriptionModel.activate(locked.organization_id, { plan: locked.plan, interval, periodStart: start, periodEnd: end }, db);
    await subscriptionModel.saveCard(locked.organization_id, { customerCode: tx.customerCode, authorizationCode: tx.authorizationCode }, db);
    await subscriptionModel.setNext(locked.organization_id, null, null, db);
    await subscriptionModel.markPaymentPaid(locked.id, { periodStart: start, periodEnd: end }, db);
    await auditModel.log(
      {
        orgId: locked.organization_id,
        userId: locked.created_by,
        action: `plan.${locked.kind}`,
        details: `${PLANS[locked.plan].name} (${interval}) — ${formatNaira(locked.amount_kobo)} (until ${end})`,
      },
      db
    );
    return { kind: locked.kind, orgId: locked.organization_id, plan: locked.plan, interval, end };
  });

  // Outside the transaction (these call Paystack): make sure renewals will follow the new plan
  if (applied) {
    try {
      if (applied.kind === 'upgrade') {
        await moveSubscription(applied.orgId, applied.plan, applied.interval, addDays(applied.end, 1));
      } else {
        await linkPaystackSubscription(applied.orgId, tx.customerId, applied.plan, applied.interval);
      }
    } catch (err) {
      // The payment counted. Renewal setup can be fixed from the Billing page (auto-renew on).
      console.error('Billing: could not set up automatic renewal:', err.message);
      await subscriptionModel.setRenewalProblem(applied.orgId, 'Automatic renewal could not be set up — turn it on again from this page.');
    }
  }
  return { status: 'paid', plan: payment.plan, applied: Boolean(applied) };
}

// After a first payment Paystack creates the subscription itself; find it and remember its code.
// (The "subscription.create" webhook does the same — whichever comes first.)
async function linkPaystackSubscription(orgId, customerId, planId, interval) {
  const sub = await subscriptionModel.find(orgId);
  const planCode = await subscriptionModel.findPlanCode(planId, interval, PLANS[planId].prices[interval]);
  if (!customerId || !planCode) return;
  const list = await paystackService.listSubscriptions(requireKey(), customerId);
  const match = list.find((s) => s.planCode === planCode && s.status === 'active');
  if (match && match.subscriptionCode !== sub.paystack_subscription_code) {
    await subscriptionModel.saveSubscriptionCode(orgId, match);
  }
}

// Stop the current Paystack subscription and start one on a different plan / interval,
// charging first on `startDate` (the day after the current period ends)
async function moveSubscription(orgId, planId, interval, startDate) {
  const key = requireKey();
  const sub = await subscriptionModel.find(orgId);
  if (!sub.paystack_customer_code || !sub.paystack_authorization_code) {
    throw new AppError(409, 'We don’t have a card on file for automatic renewal yet. Pay once and it’s saved.');
  }
  if (sub.paystack_subscription_code && sub.paystack_email_token) {
    await paystackService.disableSubscription(key, { code: sub.paystack_subscription_code, token: sub.paystack_email_token });
  }
  const created = await paystackService.createSubscription(key, {
    customerCode: sub.paystack_customer_code,
    planCode: await planCodeFor(planId, interval),
    authorizationCode: sub.paystack_authorization_code,
    startDate: `${startDate}T08:00:00+01:00`,
  });
  await subscriptionModel.saveSubscriptionCode(orgId, created);
  await subscriptionModel.setRenewalProblem(orgId, null);
}

// ---------- Changes that start with the next period (smaller plan, monthly ↔ yearly) ----------
export async function scheduleChange(auth, { plan: planId, interval }) {
  requireOwner(auth);
  const sub = await subscriptionModel.find(auth.orgId);
  const q = sub ? quote(sub, planId, interval) : { allowed: false, reason: 'Your organisation already has full access.' };
  if (!q.allowed) throw new AppError(409, q.reason);
  if (q.kind !== 'scheduled') throw new AppError(409, 'This change needs a payment — use Pay instead.');

  await moveSubscription(auth.orgId, planId, interval, q.startsOn);
  await subscriptionModel.setNext(auth.orgId, planId, interval);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'plan.change_scheduled',
    details: `${PLANS[planId].name} (${interval}) from ${q.startsOn}`,
  });
  return getBilling(auth);
}

// Undo a scheduled change: keep renewing the current plan
export async function cancelScheduledChange(auth) {
  requireOwner(auth);
  const sub = await subscriptionModel.find(auth.orgId);
  if (!sub?.next_plan) throw new AppError(409, 'There is no change waiting');
  await moveSubscription(auth.orgId, sub.plan, intervalOf(sub), addDays(sub.current_period_end, 1));
  await subscriptionModel.setNext(auth.orgId, null, null);
  return getBilling(auth);
}

// ---------- Automatic renewal on / off ----------
export async function setAutoRenew(auth, { on }) {
  requireOwner(auth);
  const sub = await subscriptionModel.find(auth.orgId);
  const desc = describeSubscription(sub);
  if (!sub || desc.isLegacy || sub.status !== 'active') throw new AppError(409, 'There is no paid plan to renew');

  if (on) {
    // a new Paystack subscription that first charges the day after this period ends
    await moveSubscription(auth.orgId, sub.next_plan || sub.plan, sub.next_interval || intervalOf(sub), addDays(sub.current_period_end, 1));
  } else {
    if (sub.paystack_subscription_code && sub.paystack_email_token) {
      await paystackService.disableSubscription(requireKey(), { code: sub.paystack_subscription_code, token: sub.paystack_email_token });
    }
    await subscriptionModel.setAutoRenew(auth.orgId, false);
  }
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: on ? 'plan.auto_renew_on' : 'plan.auto_renew_off' });
  return getBilling(auth);
}

// A Paystack page where the owner can change the card used for renewals
export async function cardLink(auth) {
  requireOwner(auth);
  const sub = await subscriptionModel.find(auth.orgId);
  if (!sub?.paystack_subscription_code) throw new AppError(409, 'No card is saved for automatic renewal yet');
  return { link: await paystackService.manageLink(requireKey(), sub.paystack_subscription_code) };
}

// ---------- An automatic renewal Paystack charged ----------
async function applyRenewal(data) {
  const reference = data.reference;
  const planInfo = await subscriptionModel.findPlanByCode(data.plan?.plan_code);
  const sub = await subscriptionModel.findByCustomerCode(data.customer?.customer_code);
  if (!planInfo || !sub) return; // not one of ours

  // Ask Paystack, as always — and the amount must be the plan's price
  const tx = await paystackService.verifyTransaction(requireKey(), reference);
  if (tx.status !== 'success' || tx.amountKobo !== Number(planInfo.amount_kobo) || tx.currency !== 'NGN') {
    console.error(`Billing: renewal ${reference} not counted (${tx.status}, ${tx.amountKobo})`);
    return;
  }

  const result = await withTransaction(async (db) => {
    const locked = await subscriptionModel.lock(sub.organization_id, db);
    const today = toDateString();
    // On time → the new period follows straight on. Long after it ran out → it starts today.
    const followsOn = locked.current_period_end && addDays(locked.current_period_end, GRACE_DAYS) >= today;
    const start = followsOn ? addDays(locked.current_period_end, 1) : today;
    const end = periodEnd(start, planInfo.interval);
    const added = await subscriptionModel.recordRenewal(
      { orgId: sub.organization_id, reference, plan: planInfo.plan, interval: planInfo.interval, amountKobo: tx.amountKobo, periodStart: start, periodEnd: end },
      db
    );
    if (!added) return null; // already counted (Paystack sent it twice)
    await subscriptionModel.activate(sub.organization_id, { plan: planInfo.plan, interval: planInfo.interval, periodStart: start, periodEnd: end }, db);
    await subscriptionModel.setNext(sub.organization_id, null, null, db);
    await auditModel.log(
      { orgId: sub.organization_id, userId: null, action: 'plan.auto_renewal', details: `${PLANS[planInfo.plan].name} (${planInfo.interval}) — ${formatNaira(tx.amountKobo)} (until ${end})` },
      db
    );
    return end;
  });
  return result;
}

const ownerUserIds = async (orgId) => {
  const [rows] = await pool.query(
    `SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
      WHERE m.organization_id = ? AND m.status = 'active' AND r.is_owner = 1`,
    [orgId]
  );
  return rows.map((r) => r.user_id);
};

// ---------- Paystack webhook ----------
export async function handleWebhook(rawBody, signature) {
  if (!env.billingPaystackKey || !paystackService.isValidSignature(rawBody, signature, env.billingPaystackKey)) {
    throw new AppError(401, 'Invalid signature');
  }
  const { event, data = {} } = JSON.parse(rawBody.toString('utf8'));

  if (event === 'charge.success') {
    // Our own checkout (backup for owners who close the tab)
    if (data.reference?.startsWith('wkbill_')) {
      if (await subscriptionModel.findPaymentByReference(data.reference)) await verifyPayment(data.reference);
      return;
    }
    // An automatic renewal
    if (data.plan?.plan_code) await applyRenewal(data);
    return;
  }

  // Paystack made the subscription after a first payment: remember its code
  if (event === 'subscription.create') {
    const sub = await subscriptionModel.findByCustomerCode(data.customer?.customer_code);
    const planInfo = await subscriptionModel.findPlanByCode(data.plan?.plan_code);
    if (sub && planInfo && planInfo.plan === (sub.next_plan || sub.plan) && planInfo.interval === (sub.next_interval || intervalOf(sub))) {
      await subscriptionModel.saveSubscriptionCode(sub.organization_id, { subscriptionCode: data.subscription_code, emailToken: data.email_token });
      if (data.authorization?.authorization_code) {
        await subscriptionModel.saveCard(sub.organization_id, { customerCode: null, authorizationCode: data.authorization.authorization_code });
      }
    }
    return;
  }

  const sub = await subscriptionModel.findBySubscriptionCode(data.subscription?.subscription_code || data.subscription_code);
  if (!sub) return;

  // The renewal charge failed (e.g. card declined or expired)
  if (event === 'invoice.payment_failed') {
    const problem = 'Paystack could not charge your card for the renewal. Update the card, or pay again before the grace period ends.';
    await subscriptionModel.setRenewalProblem(sub.organization_id, problem);
    await notify(sub.organization_id, await ownerUserIds(sub.organization_id), {
      type: 'billing.payment_failed',
      title: 'Your Workard renewal payment failed',
      body: 'Update your card on the Billing page so your team keeps access.',
      link: '/billing',
    });
    return;
  }

  // Automatic renewal stopped (by the owner on Paystack's page, or Paystack gave up)
  if (event === 'subscription.disable' || event === 'subscription.not_renew') {
    await subscriptionModel.setAutoRenew(sub.organization_id, false);
  }
}

