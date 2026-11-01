import { z } from 'zod';
import { optionalText, dateString } from './common.js';
import { nairaToKobo } from '../utils/money.js';

// Forms send NAIRA (e.g. basic: 300000). The transforms below turn them into
// KOBO fields (basicKobo: 30000000) for the services — same rule as invoices.
const naira = (label) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(1_000_000_000, `${label} is too large`)
    .default(0);

const optionalDigits = (length, message) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z
      .string()
      .trim()
      .regex(new RegExp(`^\\d{${length}}$`), message)
      .nullable()
      .optional(),
  );

export const employeePaySchema = z
  .object({
    basic: naira('Basic salary'),
    housing: naira('Housing'),
    transport: naira('Transport'),
    annualRent: naira('Annual rent'),
    nhfOptIn: z.boolean().default(false),
    bankName: optionalText(120),
    bankCode: optionalText(10),
    accountNumber: optionalDigits(10, 'Enter a 10-digit account number'),
    accountName: optionalText(160),
    pfaName: optionalText(120),
    pensionPin: optionalText(30),
    taxId: optionalText(30),
    items: z
      .array(
        z.object({
          type: z.enum(['allowance', 'deduction']),
          name: z.string().trim().min(1, 'Name the item').max(80),
          amount: naira('Amount'),
        }),
      )
      .max(30)
      .default([]),
  })
  .transform(({ basic, housing, transport, annualRent, items, ...rest }) => ({
    ...rest,
    basicKobo: nairaToKobo(basic),
    housingKobo: nairaToKobo(housing),
    transportKobo: nairaToKobo(transport),
    annualRentKobo: nairaToKobo(annualRent),
    items: items.map(({ amount, ...item }) => ({
      ...item,
      amountKobo: nairaToKobo(amount),
    })),
  }));

export const createRunSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month'),
});

export const adjustItemSchema = z
  .object({
    bonus: naira('Bonus'),
    oneOffDeduction: naira('Deduction'),
  })
  .transform(({ bonus, oneOffDeduction }) => ({
    bonusKobo: nairaToKobo(bonus),
    oneOffDeductionKobo: nairaToKobo(oneOffDeduction),
  }));

export const markPaidSchema = z.object({
  paidOn: dateString('Choose the date paid'),
  method: z.enum(['bank_upload', 'cash', 'other']).default('bank_upload'),
});

export const payrollSettingsSchema = z.object({
  payDay: z.coerce.number().int().min(1).max(31),
  payeEnabled: z.boolean(),
  pensionEnabled: z.boolean(),
  pensionEmployeeRate: z.coerce.number().min(0).max(100),
  pensionEmployerRate: z.coerce.number().min(0).max(100),
  nhfEnabled: z.boolean(),
  nhfRate: z.coerce.number().min(0).max(100),
});

export const paystackKeySchema = z.object({
  secretKey: z
    .string()
    .trim()
    .regex(
      /^sk_(live|test)_[A-Za-z0-9]{20,}$/,
      'Paste the secret key from Paystack (starts with sk_live_ or sk_test_)',
    ),
});

export const verifyAccountSchema = z.object({
  accountNumber: z.string().regex(/^\d{10}$/, 'Enter a 10-digit account number'),
  bankCode: z.string().trim().min(2, 'Choose a bank').max(10),
});
