// ============================================================
// PAYROLL CALCULATOR — one employee, one month. Pure maths, no database.
// Every amount is in KOBO (whole numbers).
//
//  1. Pay for the month   = basic + housing + transport + allowances + bonus
//                           − proration (joined mid-month / unpaid leave)
//  2. Pension (employee)  = rate% × (basic + housing + transport)   ← Pension Reform Act
//     Pension (employer)  = rate% × the same — paid by the company, NOT taken from pay
//  3. NHF                 = rate% × basic (only if enabled AND the employee opted in)
//  4. PAYE                = annual tax on (yearly pay − pension − NHF − rent relief) ÷ 12
//                           (zero if monthly pay ≤ minimum wage)
//  5. Net pay             = gross − pension − NHF − PAYE − other deductions
// ============================================================
import { PAYE_BANDS, RENT_RELIEF_RATE, RENT_RELIEF_CAP, MINIMUM_WAGE_MONTHLY } from '../config/payrollRules.js';

const pct = (amount, rate) => Math.round((amount * Number(rate)) / 100);

// Tax on a yearly taxable income, band by band
export function annualTax(taxableKobo) {
  let tax = 0;
  let lower = 0;
  for (const band of PAYE_BANDS) {
    if (taxableKobo <= lower) break;
    const inBand = Math.min(taxableKobo, band.upTo) - lower;
    tax += (inBand * band.rate) / 100;
    lower = band.upTo;
  }
  return Math.round(tax);
}

/**
 * @param pay       { basic, housing, transport, allowances, otherDeductions, annualRent, nhfOptIn } (kobo)
 * @param settings  { payeEnabled, pensionEnabled, pensionEmployeeRate, pensionEmployerRate, nhfEnabled, nhfRate }
 * @param extras    { bonus, oneOffDeduction, payableFraction } — payableFraction = days payable ÷ days in month
 */
export function calculatePay(pay, settings, extras = {}) {
  const fraction = extras.payableFraction ?? 1;
  const bonus = extras.bonus || 0;
  const oneOffDeduction = extras.oneOffDeduction || 0;

  // 1. Pay for the month (fixed pay is reduced if not every working day is payable)
  const fullFixed = pay.basic + pay.housing + pay.transport + pay.allowances;
  const basic = Math.round(pay.basic * fraction);
  const housing = Math.round(pay.housing * fraction);
  const transport = Math.round(pay.transport * fraction);
  const allowances = Math.round(pay.allowances * fraction);
  const proration = fullFixed - (basic + housing + transport + allowances);
  const gross = basic + housing + transport + allowances + bonus;

  // 2. Pension
  const pensionable = basic + housing + transport;
  const pensionEmployee = settings.pensionEnabled ? pct(pensionable, settings.pensionEmployeeRate) : 0;
  const pensionEmployer = settings.pensionEnabled ? pct(pensionable, settings.pensionEmployerRate) : 0;

  // 3. NHF
  const nhf = settings.nhfEnabled && pay.nhfOptIn ? pct(basic, settings.nhfRate) : 0;

  // 4. PAYE (worked out on a yearly basis, then split into 12)
  let paye = 0;
  const rentRelief = Math.min(pct(pay.annualRent || 0, RENT_RELIEF_RATE), RENT_RELIEF_CAP);
  if (settings.payeEnabled && gross > MINIMUM_WAGE_MONTHLY) {
    const annualTaxable = Math.max(0, gross * 12 - pensionEmployee * 12 - nhf * 12 - rentRelief);
    paye = Math.round(annualTax(annualTaxable) / 12);
  }

  // 5. Net pay
  const otherDeductions = pay.otherDeductions || 0;
  const totalDeductions = pensionEmployee + nhf + paye + otherDeductions + oneOffDeduction;
  const net = gross - totalDeductions;

  return {
    basic,
    housing,
    transport,
    allowances,
    bonus,
    proration,
    gross,
    pensionEmployee,
    pensionEmployer,
    nhf,
    paye,
    rentRelief,
    otherDeductions,
    oneOffDeduction,
    net,
  };
}
