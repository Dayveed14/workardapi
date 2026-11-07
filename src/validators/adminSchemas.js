import { z } from 'zod';
import { email, password, optionalPhone, optionalText, otpCode, dateString } from './common.js';

// ---------- Admin log-in ----------
export const adminLoginSchema = z.object({ email, password: z.string().min(1, 'Password is required').max(72) });
export const adminVerifySchema = z.object({ challengeToken: z.string().min(10), code: otpCode });
export const adminResendSchema = z.object({ challengeToken: z.string().min(10) });
export const adminSetupSchema = z.object({ password });
export const addAdminSchema = z.object({ fullName: z.string().trim().min(2, 'Enter their name').max(120), email });

// ---------- Companies ----------
const STATUSES = ['free', 'trial', 'trial_ended', 'active', 'grace', 'expired', 'exempt', 'suspended'];
export const companiesQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export const extendTrialSchema = z.object({ days: z.coerce.number().int().min(1, 'At least 1 day').max(365, 'At most a year') });
export const setPlanSchema = z.object({
  plan: z.enum(['starter', 'business', 'enterprise']),
  interval: z.enum(['monthly', 'yearly']),
  periodEnd: dateString(),
});
export const exemptSchema = z.object({ exempt: z.boolean() });
export const suspendSchema = z.object({ reason: z.string().trim().min(5, 'Say why (the owner is emailed this)').max(255) });

// ---------- Users, payments ----------
export const searchSchema = z.object({ search: z.string().trim().max(120).optional() });
export const lockSchema = z.object({ locked: z.boolean() });
export const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), status: z.string().max(20).optional() });

// ---------- Prices & trial ----------
const kobo = z.coerce.number().int().min(10_000, 'At least ₦100');
const planPrices = z.object({ monthly: kobo, yearly: kobo });
export const pricingSchema = z.object({
  prices: z.object({ starter: planPrices, business: planPrices, enterprise: planPrices }),
  trialDays: z.coerce.number().int().min(1, 'At least 1 day').max(90, 'At most 90 days'),
});

// ---------- Announcements, demos ----------
export const platformAnnouncementSchema = z.object({
  title: z.string().trim().min(3, 'Give it a title').max(200),
  body: z.string().trim().min(5, 'Write the message').max(2000),
  audience: z.enum(['all', 'trial', 'paying']).default('all'),
  sendEmail: z.boolean().default(false),
});
export const demoUpdateSchema = z.object({ status: z.enum(['new', 'contacted', 'closed']).optional(), note: optionalText(500) });

// From the website (no login)
export const demoRequestSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(120),
  email,
  phone: optionalPhone,
  company: optionalText(160),
  companySize: z.enum(['1-10', '11-50', '51-200', '201-500', '500+']).optional().nullable(),
  message: optionalText(1000),
  // A hidden field people never fill in — bots usually do
  website: z.string().max(0).optional(),
});

export const supportGrantSchema = z.object({
  hours: z.coerce.number().int(),
  reason: optionalText(255),
});
