import { z } from 'zod';

// Form fields arrive as text when a file is attached (multipart), so "true"/"false" → boolean
const flag = z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 1, z.boolean());

export const postSchema = z
  .object({
    audienceType: z.enum(['company', 'branch', 'department', 'team'], { errorMap: () => ({ message: 'Choose who it’s for' }) }),
    audienceId: z.coerce.number().int().positive().optional().nullable(),
    title: z.string().trim().min(3, 'Give it a short title').max(200),
    body: z.string().trim().min(1, 'Write the announcement').max(10000),
    isPinned: flag.optional().default(false),
    needsAck: flag.optional().default(false),
    sendEmail: flag.optional().default(false),
  })
  .refine((d) => d.audienceType === 'company' || d.audienceId, { message: 'Choose the group', path: ['audienceId'] });

export const updatePostSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
  isPinned: z.boolean().optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'Write a comment').max(2000),
});

export const feedQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
});
