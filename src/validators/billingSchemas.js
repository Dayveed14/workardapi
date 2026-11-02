import { z } from 'zod';

export const checkoutSchema = z.object({
  plan: z.enum(['starter', 'business', 'enterprise'], { errorMap: () => ({ message: 'Choose a plan' }) }),
});

export const verifySchema = z.object({
  reference: z.string().trim().regex(/^wkbill_[a-f0-9]{24}$/, 'Invalid payment reference'),
});
