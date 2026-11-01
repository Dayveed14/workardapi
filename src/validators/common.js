import { z } from 'zod';

// Forms send "" for empty fields. These helpers turn "" into null/undefined.
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

export const email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(190);

export const password = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const optionalText = (max = 255) =>
  z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

export const optionalPhone = z.preprocess(
  emptyToNull,
  z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number').nullable().optional()
);

export const optionalId = z.preprocess(emptyToNull, z.coerce.number().int().positive().nullable().optional());

export const requiredId = (message = 'Choose an option') =>
  z.coerce.number({ invalid_type_error: message }).int().positive(message);

export const dateString = (message = 'Enter a valid date') =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, message);

export const optionalDate = z.preprocess(emptyToNull, dateString().nullable().optional());

export const otpCode = z
  .string({ required_error: 'Enter the 6-digit code' })
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected'], { errorMap: () => ({ message: 'Choose approve or reject' }) }),
  note: optionalText(255),
});
