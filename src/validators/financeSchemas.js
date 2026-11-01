import { z } from 'zod';
import { optionalText, optionalId, requiredId, dateString } from './common.js';
import { nairaToKobo } from '../utils/money.js';
import { PAYMENT_METHODS } from './invoiceSchemas.js';

const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM')
  .optional();

export const monthQuerySchema = z.object({ month });

export const entriesQuerySchema = z.object({
  month,
  type: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['income', 'expense']).optional()),
  categoryId: optionalId,
});

// Amount comes in naira and is stored in kobo
export const entrySchema = z
  .object({
    type: z.enum(['income', 'expense']),
    categoryId: requiredId('Choose a category'),
    amount: z.coerce.number({ invalid_type_error: 'Enter an amount' }).min(0.01, 'Amount must be more than zero').max(10_000_000_000),
    entryDate: dateString('Choose a date'),
    description: z.string().trim().min(2, 'Describe what this was for').max(255),
    party: optionalText(160),
    method: z.enum(PAYMENT_METHODS).default('transfer'),
    reference: optionalText(100),
    requestId: z.string().trim().min(8).max(64).optional(),
  })
  .transform(({ amount, ...data }) => ({ ...data, amountKobo: nairaToKobo(amount) }));

export const categorySchema = z.object({
  type: z.enum(['income', 'expense']),
  name: z.string().trim().min(2, 'Name is required').max(80),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  isActive: z.boolean().default(true),
});
