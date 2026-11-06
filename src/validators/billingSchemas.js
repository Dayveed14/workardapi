import { z } from 'zod';

export const checkoutSchema = z.object({
  plan: z.enum(['starter', 'business', 'enterprise'], { errorMap: () => ({ message: 'Choose a plan' }) }),
  interval: z.enum(['monthly', 'yearly'], { errorMap: () => ({ message: 'Choose monthly or yearly' }) }).default('monthly'),
});

export const autoRenewSchema = z.object({ on: z.boolean() });

export const verifySchema = z.object({
  reference: z.string().trim().regex(/^wkbill_[a-f0-9]{24}$/, 'Invalid payment reference'),
});
