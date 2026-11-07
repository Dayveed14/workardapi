import { PLANS, PLAN_ORDER, INTERVALS, billing } from '../config/plans.js';
import * as settingModel from '../models/settingModel.js';
import * as adminModel from '../models/adminModel.js';
import { requestRebuild } from './deployHookService.js';
import AppError from '../utils/AppError.js';

// ============================================================
// PRICES & TRIAL LENGTH — editable by the super admin, no deploy needed.
//
// config/plans.js holds the DEFAULTS. Saved values (platform_settings) are laid
// over them when the API starts and right after a change, so everything that
// reads PLANS[plan].prices or billing.trialDays sees the new numbers.
//
// A new price only affects NEW payments: Paystack keeps charging existing
// subscribers their old price until they change plan (one Paystack plan per price).
// ============================================================

const DEFAULT_PRICES = Object.fromEntries(PLAN_ORDER.map((id) => [id, { ...PLANS[id].prices }]));
const DEFAULT_TRIAL_DAYS = billing.trialDays;

export async function applySettings() {
  const saved = await settingModel.all();
  for (const id of PLAN_ORDER) {
    PLANS[id].prices = { ...DEFAULT_PRICES[id], ...(saved.prices?.[id] || {}) };
  }
  billing.trialDays = Number.isInteger(saved.trialDays) ? saved.trialDays : DEFAULT_TRIAL_DAYS;
}

export function currentPricing() {
  return {
    plans: PLAN_ORDER.map((id) => ({
      id,
      name: PLANS[id].name,
      prices: { ...PLANS[id].prices },
      defaults: { ...DEFAULT_PRICES[id] },
    })),
    trialDays: billing.trialDays,
    defaultTrialDays: DEFAULT_TRIAL_DAYS,
    billingEnabled: billing.enabled,
  };
}

// prices: { starter: { monthly, yearly }, … } in kobo
export async function savePricing(admin, { prices, trialDays }) {
  for (const id of PLAN_ORDER) {
    for (const interval of INTERVALS) {
      const kobo = prices?.[id]?.[interval];
      if (!Number.isInteger(kobo) || kobo < 100_00) throw new AppError(422, `${PLANS[id].name} ${interval}: enter a price of at least ₦100`);
    }
    if (prices[id].yearly > prices[id].monthly * 12) {
      throw new AppError(422, `${PLANS[id].name}: the yearly price is more than 12 monthly payments`);
    }
  }
  const before = currentPricing();
  await settingModel.set('prices', Object.fromEntries(PLAN_ORDER.map((id) => [id, { monthly: prices[id].monthly, yearly: prices[id].yearly }])), admin.userId);
  await settingModel.set('trialDays', trialDays, admin.userId);
  await applySettings();

  const changes = PLAN_ORDER.flatMap((id) =>
    INTERVALS.filter((i) => before.plans.find((p) => p.id === id).prices[i] !== prices[id][i]).map(
      (i) => `${PLANS[id].name} ${i} ₦${before.plans.find((p) => p.id === id).prices[i] / 100} → ₦${prices[id][i] / 100}`
    )
  );
  if (before.trialDays !== trialDays) changes.push(`trial ${before.trialDays} → ${trialDays} days`);
  await adminModel.log(admin.userId, 'pricing.updated', { details: changes.join('; ') || 'no change' });
  if (changes.length) requestRebuild('prices changed');
  return currentPricing();
}

export async function resetPricing(admin) {
  await settingModel.remove('prices');
  await settingModel.remove('trialDays');
  await applySettings();
  await adminModel.log(admin.userId, 'pricing.reset', { details: 'back to the defaults in config/plans.js' });
  requestRebuild('prices reset');
  return currentPricing();
}
