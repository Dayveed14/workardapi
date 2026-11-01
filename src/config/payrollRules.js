// ============================================================
// NIGERIAN PAYROLL RULES
// Nigeria Tax Act 2025 — personal income tax, in force from 1 January 2026.
//
// ⚠ Tax law changes. If the rates change, update THIS file only —
//   the calculator (utils/payrollCalc.js) reads everything from here.
//   Have a tax adviser confirm before relying on it for filing.
// ============================================================

const naira = (n) => n * 100; // amounts below are written in naira, stored in kobo

// Annual PAYE bands — each band is taxed at its own rate
export const PAYE_BANDS = [
  { upTo: naira(800_000), rate: 0 }, //          first ₦800,000
  { upTo: naira(3_000_000), rate: 15 }, //       next ₦2,200,000
  { upTo: naira(12_000_000), rate: 18 }, //      next ₦9,000,000
  { upTo: naira(25_000_000), rate: 21 }, //      next ₦13,000,000
  { upTo: naira(50_000_000), rate: 23 }, //      next ₦25,000,000
  { upTo: Infinity, rate: 25 }, //               above ₦50,000,000
];

// Rent relief replaced the old Consolidated Relief Allowance (CRA):
// 20% of annual rent paid, capped at ₦500,000 a year.
export const RENT_RELIEF_RATE = 20;
export const RENT_RELIEF_CAP = naira(500_000);

// Employees earning the national minimum wage or less pay no PAYE.
export const MINIMUM_WAGE_MONTHLY = naira(70_000);

// Defaults for a new organisation (editable in Settings → Payroll)
export const DEFAULT_PAYROLL_SETTINGS = {
  pensionEmployeeRate: 8, //  Pension Reform Act 2014 minimum (employee)
  pensionEmployerRate: 10, // Pension Reform Act 2014 minimum (employer)
  nhfRate: 2.5, //            National Housing Fund — optional for private employers, needs employee consent
};
