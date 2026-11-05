import { PLANS, GRACE_DAYS, RENEW_WINDOW_DAYS, billing } from '../config/plans.js';
import { toDateString, addDays } from './dates.js';

// Turns a `subscriptions` row into what the app needs to know:
//   status   free            → billing is switched off (BILLING_ENABLED=false): everything, no charge
//            trial           → free trial of the chosen plan (TRIAL_DAYS)
//            trial_ended     → trial over, locked until the owner pays
//            active          → paid and within the year
//            grace           → the year ended less than GRACE_DAYS ago (still works, renew now)
//            expired         → locked until the owner pays
//   usable   can the organisation use the app right now?
//
// No row at all = an organisation from before plans existed → full access (legacy).
export function describeSubscription(row, today = toDateString()) {
  if (!row || row.is_legacy) {
    const plan = PLANS.enterprise;
    return {
      plan: plan.id,
      planName: plan.name,
      status: 'active',
      usable: true,
      isLegacy: true,
      billingEnabled: billing.enabled,
      periodEnd: null,
      daysLeft: null,
      canRenew: false,
      features: plan.features,
      limits: limitsOf(plan),
    };
  }

  const paid = row.status === 'active';

  // Billing switched off: everyone who hasn't paid gets everything, free
  if (!billing.enabled && !paid) {
    const plan = PLANS.enterprise;
    return {
      plan: plan.id,
      planName: plan.name,
      status: 'free',
      usable: true,
      isLegacy: false,
      billingEnabled: false,
      periodEnd: null,
      daysLeft: null,
      canRenew: false,
      features: plan.features,
      limits: limitsOf(plan),
    };
  }

  const plan = PLANS[row.plan];

  // Not paid yet → a free trial. Organisations that signed up while Workard was free
  // (no trial end saved) start their trial on the day billing was switched on.
  if (!paid) {
    const trialStart = [billing.startDate, row.created_at && String(row.created_at).slice(0, 10)].filter(Boolean).sort().at(-1) || today;
    const trialEnd = row.current_period_end || addDays(trialStart, billing.trialDays - 1);
    const onTrial = trialEnd >= today;
    return {
      plan: plan.id,
      planName: plan.name,
      status: onTrial ? 'trial' : 'trial_ended',
      usable: onTrial,
      isLegacy: false,
      billingEnabled: true,
      periodEnd: trialEnd,
      daysLeft: daysBetween(today, trialEnd),
      canRenew: false,
      features: plan.features,
      limits: limitsOf(plan),
    };
  }

  let status = 'active';
  if (row.current_period_end < today) {
    status = addDays(row.current_period_end, GRACE_DAYS) >= today ? 'grace' : 'expired';
  }
  const daysLeft = row.current_period_end ? daysBetween(today, row.current_period_end) : null;

  return {
    plan: plan.id,
    planName: plan.name,
    status,
    usable: status === 'active' || status === 'grace',
    isLegacy: false,
    billingEnabled: billing.enabled,
    periodEnd: row.current_period_end,
    daysLeft,
    canRenew: daysLeft === null || daysLeft <= RENEW_WINDOW_DAYS,
    features: plan.features,
    limits: limitsOf(plan),
  };
}

function limitsOf(plan) {
  return { maxEmployees: plan.maxEmployees, maxBranches: plan.maxBranches, customRoles: plan.customRoles };
}

export function daysBetween(from, to) {
  const a = Date.UTC(...from.split('-').map((n, i) => (i === 1 ? n - 1 : Number(n))));
  const b = Date.UTC(...to.split('-').map((n, i) => (i === 1 ? n - 1 : Number(n))));
  return Math.round((b - a) / 86400000);
}

// A paid year runs from `start` up to the day before the same date next year
// (1 Mar 2026 → 28 Feb 2027).
export function oneYearFrom(start) {
  const [y, m, d] = start.split('-').map(Number);
  const next = new Date(y + 1, m - 1, d);
  next.setDate(next.getDate() - 1);
  return toDateString(next);
}
