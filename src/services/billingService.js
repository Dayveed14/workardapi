import crypto from 'node:crypto';
import * as subscriptionModel from '../models/subscriptionModel.js';
import * as userModel from '../models/userModel.js';
import * as auditModel from '../models/auditModel.js';
import * as paystackService from './paystackService.js';
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { PLANS, PLAN_ORDER, FEATURE_NAMES, billing } from '../config/plans.js';
import { describeSubscription, daysBetween, oneYearFrom } from '../utils/subscription.js';
import { toDateString, addDays, formatDateLong } from '../utils/dates.js';
import { formatNaira } from '../utils/money.js';
import AppError from '../utils/AppError.js';

// ============================================================
// PLANS & BILLING — organisations pay Workard once a year.
//
//   sign up (plan chosen) → free trial (TRIAL_DAYS) → pay, or the app locks when the trial ends
//   BILLING_ENABLED=false → no trial, no payments: everyone has everything for free
//   owner pays on Paystack → Paystack sends them back to /billing/callback
//   → we ASK PAYSTACK whether it was paid (never trust the browser)
//   → subscription active for one year
//
// The same "apply payment" step also runs from Paystack's webhook, so a
// payment counts even if the owner closes the tab before coming back.
// Applying is safe to repeat: the payment row is locked and checked first.
// ============================================================

const rank = (planId) => PLAN_ORDER.indexOf(planId);

function requireKey() {
  if (!env.billingPaystackKey) throw new AppError(503, 'Payments are not set up yet (PAYSTACK_SECRET_KEY is missing on the server)');
  return env.billingPaystackKey;
}

function requireOwner(auth) {
  if (!auth.role.isOwner) throw new AppError(403, 'Only the owner of the organisation can manage the plan and payments');
}

// What would the owner pay right now to move to `planId`?
//   pending / expired / grace → a new year on any plan, full price
//   active, bigger plan       → upgrade: only the difference, for the days left in the year
//   active, same plan         → renew early (last 60 days of the year), full price, adds a year
//   active, smaller plan      → not now: choose it when the year ends
export function quote(sub, planId, today = toDateString()) {
  const plan = PLANS[planId];
  const desc = describeSubscription(sub, today);
  if (desc.isLegacy) return { allowed: false, reason: 'Your organisation already has full access.' };
  if (desc.status === 'free') return { allowed: false, reason: 'Workard is free during early access — nothing to pay yet.' };

  if (['trial', 'trial_ended', 'expired', 'grace'].includes(desc.status)) {
    return { allowed: true, kind: desc.status.startsWith('trial') ? 'new' : 'renewal', amountKobo: plan.priceKobo };
  }
  if (rank(planId) > rank(desc.plan)) {
    const daysLeft = daysBetween(today, sub.current_period_end) + 1; // today counts
    const difference = PLANS[planId].priceKobo - PLANS[desc.plan].priceKobo;
    // rounded to the naira
    const amountKobo = Math.max(10_000, Math.round((difference * daysLeft) / 365 / 100) * 100);
    return { allowed: true, kind: 'upgrade', amountKobo, daysLeft };
  }
  if (planId === desc.plan) {
    return desc.canRenew
      ? { allowed: true, kind: 'renewal', amountKobo: plan.priceKobo }
      : { allowed: false, reason: `You can renew in the last 60 days of your year (it ends ${formatDateLong(sub.current_period_end)}).` };
  }
  return { allowed: false, reason: `You can move to ${plan.name} when your current year ends (${formatDateLong(sub.current_period_end)}).` };
}

// ---------- What the Billing page shows ----------
export async function getBilling(auth) {
  const sub = await subscriptionModel.find(auth.orgId);
  const subscription = describeSubscription(sub);
  return {
    subscription,
    isOwner: auth.role.isOwner,
    plans: PLAN_ORDER.map((id) => ({
      ...publicPlan(PLANS[id]),
      quote: auth.role.isOwner && sub ? quote(sub, id) : null,
    })),
    payments: auth.role.isOwner ? await subscriptionModel.listPayments(auth.orgId) : [],
  };
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    priceKobo: plan.priceKobo,
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

// ---------- Step 1: start a payment ----------
export async function checkout(auth, { plan: planId }) {
  requireOwner(auth);
  const key = requireKey();
  const sub = await subscriptionModel.find(auth.orgId);
  if (!sub) throw new AppError(409, 'Your organisation already has full access.');

  const q = quote(sub, planId);
  if (!q.allowed) throw new AppError(409, q.reason);

  const reference = `wkbill_${crypto.randomBytes(12).toString('hex')}`;
  const paymentId = await subscriptionModel.createPayment({
    orgId: auth.orgId,
    reference,
    plan: planId,
    kind: q.kind,
    amountKobo: q.amountKobo,
    createdBy: auth.userId,
  });

  const user = await userModel.findById(auth.userId);
  const { authorizationUrl } = await paystackService.initializeTransaction(key, {
    email: user.email,
    amountKobo: q.amountKobo,
    reference,
    callbackUrl: `${env.clientUrls[0]}/billing/callback`,
    metadata: { organizationId: auth.orgId, plan: planId, kind: q.kind },
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

    const today = toDateString();
    let start;
    let end;
    if (locked.kind === 'upgrade' && sub.current_period_end >= today) {
      // same year, bigger plan
      start = sub.current_period_start;
      end = sub.current_period_end;
    } else if (locked.kind === 'renewal' && sub.current_period_end && sub.current_period_end >= today) {
      // early renewal: the new year starts the day after the current one ends
      start = addDays(sub.current_period_end, 1);
      end = oneYearFrom(start);
    } else {
      start = today;
      end = oneYearFrom(today);
    }

    await subscriptionModel.activate(locked.organization_id, { plan: locked.plan, periodStart: start, periodEnd: end }, db);
    await subscriptionModel.markPaymentPaid(locked.id, { periodStart: start, periodEnd: end }, db);
    await auditModel.log(
      {
        orgId: locked.organization_id,
        userId: locked.created_by,
        action: `plan.${locked.kind}`,
        details: `${PLANS[locked.plan].name} — ${formatNaira(locked.amount_kobo)} (until ${end})`,
      },
      db
    );
    return true;
  });

  return { status: 'paid', plan: payment.plan, applied };
}

// ---------- Paystack webhook (backup for owners who close the tab) ----------
export async function handleWebhook(rawBody, signature) {
  if (!env.billingPaystackKey || !paystackService.isValidSignature(rawBody, signature, env.billingPaystackKey)) {
    throw new AppError(401, 'Invalid signature');
  }
  const event = JSON.parse(rawBody.toString('utf8'));
  const reference = event.data?.reference;
  if (event.event !== 'charge.success' || !reference?.startsWith('wkbill_')) return; // not a plan payment
  const payment = await subscriptionModel.findPaymentByReference(reference);
  if (payment) await verifyPayment(reference);
}
