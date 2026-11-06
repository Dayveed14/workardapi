import { z } from 'zod';

export const staffRequestSchema = z.object({
  type: z.enum(['advance', 'loan'], { errorMap: () => ({ message: 'Choose advance or loan' }) }),
  // naira from the form → kobo
  amount: z.coerce.number({ invalid_type_error: 'Enter an amount' }).positive('Enter an amount').max(1_000_000_000),
  reason: z.string().trim().min(5, 'Tell your manager what it’s for').max(1000),
}).transform(({ amount, ...rest }) => ({ ...rest, amountKobo: Math.round(amount * 100) }));

export const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional().nullable(),
});

export const requestListSchema = z.object({
  view: z.enum(['mine', 'approvals', 'payouts']).default('mine'),
});

export const feedbackSchema = z.object({
  category: z.enum(['job', 'complaint', 'suggestion'], { errorMap: () => ({ message: 'Choose a type' }) }),
  subject: z.string().trim().min(3, 'Add a short subject').max(200),
  body: z.string().trim().min(10, 'Tell us a bit more (at least a sentence)').max(5000),
  isAnonymous: z.boolean().default(false),
});

export const feedbackReplySchema = z.object({
  body: z.string().trim().max(5000).optional().default(''),
  status: z.enum(['received', 'in_review', 'resolved']).optional(),
}).refine((d) => d.body || d.status, { message: 'Write a reply', path: ['body'] });

export const feedbackListSchema = z.object({
  status: z.enum(['received', 'in_review', 'resolved']).optional(),
});
