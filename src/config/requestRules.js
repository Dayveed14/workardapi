// ============================================================
// STAFF LOAN & SALARY ADVANCE RULES — change them here only.
// "Basic" means basic pay only (no housing, transport, allowances or bonuses).
// ============================================================

export const LOAN = {
  maxTimesAnnualBasic: 1, //  borrow up to 100% of a year's basic pay (all open loans together)
  months: 12, //              repaid over 12 months, through payroll
  interestRateBp: 500, //     5% flat: repay amount × 1.05 (bp = basis points, 500 = 5%)
};

export const ADVANCE = {
  maxMonthsOfBasic: 1, //     up to one month's basic pay
  months: 1, //               taken back in full from the next payroll
  interestRateBp: 0,
};

// The amount to repay and the monthly deduction (the last month takes whatever is left)
export function repaymentPlan(type, amountKobo) {
  const rules = type === 'loan' ? LOAN : ADVANCE;
  const total = Math.round((amountKobo * (10_000 + rules.interestRateBp)) / 10_000);
  // rounded up to the naira so the last month is never bigger than the others
  const monthly = Math.ceil(total / rules.months / 100) * 100;
  return { totalKobo: total, monthlyKobo: monthly, months: rules.months, interestRateBp: rules.interestRateBp };
}
