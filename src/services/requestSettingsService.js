import * as requestSettingModel from '../models/requestSettingModel.js';
import * as auditModel from '../models/auditModel.js';
import { DEFAULT_RULES } from '../config/requestRules.js';
import { formatNaira } from '../utils/money.js';

// ============================================================
// LOANS & ADVANCES SETTINGS — each company sets its own:
//   loans:    on/off · up to X% of a year's basic pay (+ an optional ₦ ceiling) · months · % flat interest
//   advances: on/off · up to X% of a month's basic pay · months to take it back · % interest
// New companies (and anyone who never changed them) use DEFAULT_RULES.
// The terms are copied onto each request, so a change only affects NEW requests.
// ============================================================

export async function getRules(orgId) {
  const row = await requestSettingModel.find(orgId);
  if (!row) return { ...DEFAULT_RULES, isDefault: true };
  return {
    loansEnabled: Boolean(row.loans_enabled),
    loanMaxPercent: Number(row.loan_max_percent),
    loanMaxKobo: row.loan_max_kobo === null ? null : Number(row.loan_max_kobo),
    loanMonths: Number(row.loan_months),
    loanInterestBp: Number(row.loan_interest_bp),
    advancesEnabled: Boolean(row.advances_enabled),
    advanceMaxPercent: Number(row.advance_max_percent),
    advanceMonths: Number(row.advance_months),
    advanceInterestBp: Number(row.advance_interest_bp),
    isDefault: false,
    updatedAt: row.updated_at,
  };
}

export const defaults = () => ({ ...DEFAULT_RULES });

// One line for the activity log, e.g. "loans: 50% of yearly basic (max ₦1,000,000), 6 months, 3%"
function describe(r) {
  const loans = r.loansEnabled
    ? `loans: ${r.loanMaxPercent}% of yearly basic${r.loanMaxKobo ? ` (max ${formatNaira(r.loanMaxKobo)})` : ''}, ${r.loanMonths} months, ${r.loanInterestBp / 100}%`
    : 'loans: off';
  const advances = r.advancesEnabled
    ? `advances: ${r.advanceMaxPercent}% of monthly basic, ${r.advanceMonths} month${r.advanceMonths === 1 ? '' : 's'}, ${r.advanceInterestBp / 100}%`
    : 'advances: off';
  return `${loans}; ${advances}`;
}

export async function updateRules(auth, data) {
  await requestSettingModel.save(auth.orgId, data, auth.userId);
  const rules = await getRules(auth.orgId);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'requests.settings_updated', details: describe(rules) });
  return rules;
}

export async function resetRules(auth) {
  await requestSettingModel.remove(auth.orgId);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'requests.settings_updated', details: `back to the defaults — ${describe(DEFAULT_RULES)}` });
  return getRules(auth.orgId);
}
