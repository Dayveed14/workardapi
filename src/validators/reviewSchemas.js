import { z } from 'zod';
import { optionalText, optionalId } from './common.js';

// "2026-11" (monthly) or "2026-Q4" (quarterly)
const period = z
  .string({ required_error: 'Choose the period' })
  .regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, 'Choose a month (2026-11) or quarter (2026-Q4)');

const rating = z.coerce.number().int().min(1, 'Rate 1 to 5').max(5, 'Rate 1 to 5');

export const reviewSettingsSchema = z
  .object({
    frequency: z.enum(['monthly', 'quarterly']),
    selfReview: z.boolean(),
    criteria: z
      .array(
        z.object({
          id: optionalId,
          name: z.string().trim().min(2, 'Name each criterion').max(120),
          description: optionalText(255),
          weight: z.coerce.number().int().min(1, 'Weight must be at least 1').max(100),
        })
      )
      .min(1, 'Add at least one thing to rate')
      .max(12, 'Keep it to 12 or fewer'),
  })
  .refine((d) => d.criteria.reduce((s, c) => s + c.weight, 0) === 100, {
    message: 'The weights must add up to 100',
    path: ['criteria'],
  });

export const listReviewsSchema = z.object({
  view: z.enum(['mine', 'team']).default('team'),
  period: z.preprocess((v) => (v === '' ? undefined : v), period.optional()),
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['open', 'self_review', 'manager_review', 'acknowledgement', 'completed', 'cancelled']).optional()
  ),
  employeeId: optionalId,
});

export const reviewablesSchema = z.object({ period });

export const startReviewsSchema = z.object({
  period,
  employeeIds: z.array(z.coerce.number().int().positive()).min(1, 'Choose at least one person').max(500),
});

// Saving part of a review. `submit: false` = save as draft, `submit: true` = hand it on.
export const selfReviewSchema = z.object({
  scores: z.array(z.object({ id: z.coerce.number().int().positive(), rating: rating.nullable().optional() })),
  summary: optionalText(5000),
  submit: z.boolean().default(false),
});

export const managerReviewSchema = z.object({
  scores: z.array(
    z.object({
      id: z.coerce.number().int().positive(),
      rating: rating.nullable().optional(),
      comment: optionalText(500),
    })
  ),
  summary: optionalText(5000),
  goals: optionalText(5000),
  submit: z.boolean().default(false),
});

export const acknowledgeSchema = z.object({ comment: optionalText(3000) });
