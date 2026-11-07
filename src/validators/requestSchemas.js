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

// Settings → Loans & advances (percentages come in as e.g. 5 or 2.5 and are stored as basis points)
const percentToBp = z.coerce.number().min(0, 'Can’t be negative').max(100, 'At most 100%').transform((v) => Math.round(v * 100));
export const requestSettingsSchema = z
  .object({
    loansEnabled: z.boolean(),
    loanMaxPercent: z.coerce.number().int().min(1, 'At least 1%').max(500, 'At most 500%'),
    loanMaxNaira: z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().int().min(1000, 'At least ₦1,000').nullable()),
    loanMonths: z.coerce.number().int().min(1, 'At least 1 month').max(60, 'At most 60 months'),
    loanInterestPercent: percentToBp,
    advancesEnabled: z.boolean(),
    advanceMaxPercent: z.coerce.number().int().min(1, 'At least 1%').max(100, 'At most 100% of a month’s basic'),
    advanceMonths: z.coerce.number().int().min(1, 'At least 1 month').max(6, 'At most 6 months'),
    advanceInterestPercent: percentToBp,
  })
  .transform(({ loanMaxNaira, loanInterestPercent, advanceInterestPercent, ...r }) => ({
    ...r,
    loanMaxKobo: loanMaxNaira === null ? null : loanMaxNaira * 100,
    loanInterestBp: loanInterestPercent,
    advanceInterestBp: advanceInterestPercent,
  }));
