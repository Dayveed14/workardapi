import { z } from 'zod';
import { optionalText, optionalDate, requiredId, dateString } from './common.js';
import { nairaToKobo } from '../utils/money.js';

// Forms send NAIRA. Here it is turned into KOBO (whole numbers) for the database.
const naira = (label, { allowZero = true } = {}) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .min(allowZero ? 0 : 0.01, allowZero ? `${label} cannot be negative` : `${label} must be more than zero`)
    .max(10_000_000_000, `${label} is too large`);

const itemSchema = z
  .object({
    description: z.string().trim().min(1, 'Describe the item').max(255),
    quantity: z.coerce.number().positive('Quantity must be more than zero').max(1_000_000),
    unitPrice: naira('Price'),
  })
  .transform(({ unitPrice, ...item }) => ({ ...item, unitPriceKobo: nairaToKobo(unitPrice) }));

export const invoiceSchema = z
  .object({
    customerId: requiredId('Choose a customer'),
    issueDate: optionalDate,
    dueDate: optionalDate,
    items: z.array(itemSchema).min(1, 'Add at least one item').max(100),
    discount: naira('Discount').default(0),
    taxRate: z.coerce.number().min(0).max(100).default(0),
    notes: optionalText(1000),
  })
  .transform(({ discount, ...data }) => ({ ...data, discountKobo: nairaToKobo(discount) }));

// For editing, dates are required (the invoice already has them)
export const updateInvoiceSchema = z
  .object({
    customerId: requiredId('Choose a customer'),
    issueDate: dateString('Choose the issue date'),
    dueDate: dateString('Choose the due date'),
    items: z.array(itemSchema).min(1, 'Add at least one item').max(100),
    discount: naira('Discount').default(0),
    taxRate: z.coerce.number().min(0).max(100).default(0),
    notes: optionalText(1000),
  })
  .transform(({ discount, ...data }) => ({ ...data, discountKobo: nairaToKobo(discount) }));

export const listInvoicesSchema = z.object({
  filter: z.enum(['all', 'draft', 'unpaid', 'overdue', 'paid', 'void']).default('all'),
  customerId: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  search: optionalText(100),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const sendInvoiceSchema = z.object({
  channel: z.enum(['email', 'whatsapp', 'link']).default('link'),
});

export const PAYMENT_METHODS = ['transfer', 'cash', 'pos', 'card', 'cheque', 'other'];

export const paymentSchema = z
  .object({
    amount: naira('Amount', { allowZero: false }),
    paidOn: dateString('Choose the payment date'),
    method: z.enum(PAYMENT_METHODS).default('transfer'),
    reference: optionalText(100),
    note: optionalText(255),
    // A random id from the form — makes the request safe to send twice
    requestId: z.string().trim().min(8).max(64).optional(),
  })
  .transform(({ amount, ...data }) => ({ ...data, amountKobo: nairaToKobo(amount) }));

export const invoiceSettingsSchema = z.object({
  prefix: z.string().trim().min(1, 'Add a prefix').max(10).regex(/^[A-Za-z0-9-/]+$/, 'Letters, numbers, - or / only'),
  defaultDueDays: z.coerce.number().int().min(0).max(365),
  defaultTaxRate: z.coerce.number().min(0).max(100),
  bankName: optionalText(120),
  accountName: optionalText(160),
  accountNumber: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit account number').nullable().optional()
  ),
  footerNote: optionalText(500),
});

// ---------- Branding ----------
export const brandingSchema = z.object({
  brandColor: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour').nullable()
  ),
  signatoryName: optionalText(120),
  signatoryTitle: optionalText(120),
});

// The customer accepting on the public link. The signature is a small PNG drawn in the browser.
export const acceptInvoiceSchema = z.object({
  name: z.string().trim().min(2, 'Type your full name').max(120),
  signature: z
    .string()
    .startsWith('data:image/png;base64,', 'Sign in the box')
    .max(150_000, 'That signature is too large — clear it and sign again'),
  note: optionalText(1000),
});
