// ============================================================
// STAFF LOAN & SALARY ADVANCE RULES — the DEFAULTS.
// Each company can change its own in Settings → Loans & advances
// (table staff_request_settings; no row = these defaults).
// "Basic" means basic pay only (no housing, transport, allowances or bonuses).
// ============================================================

export const DEFAULT_RULES = {
  loansEnabled: true,
  loanMaxPercent: 100, //      borrow up to 100% of a year's basic pay (all open loans together)
  loanMaxKobo: null, //        optional fixed ceiling in kobo (null = no ceiling)
  loanMonths: 12, //           repaid over 12 months, through payroll
  loanInterestBp: 500, //      5% flat: repay amount × 1.05 (bp = basis points, 500 = 5%)

  advancesEnabled: true,
  advanceMaxPercent: 100, //   up to 100% of one month's basic pay
  advanceMonths: 1, //         taken back from the next payroll
  advanceInterestBp: 0,
};

// The amount to repay and the monthly deduction, for a company's rules.
// The interest and months are saved on each request, so changing the rules
// never changes loans people already have.
export function repaymentPlan(rules, type, amountKobo) {
  const months = type === 'loan' ? rules.loanMonths : rules.advanceMonths;
  const interestRateBp = type === 'loan' ? rules.loanInterestBp : rules.advanceInterestBp;
  const total = Math.round((amountKobo * (10_000 + interestRateBp)) / 10_000);
  // rounded up to the naira so the last month is never bigger than the others
  const monthly = Math.ceil(total / months / 100) * 100;
  return { totalKobo: total, monthlyKobo: monthly, months, interestRateBp };
}
