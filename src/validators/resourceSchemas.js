import { z } from 'zod';

const flag = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean());

// Multipart when it's a file, JSON when it's a document
export const resourceSchema = z
  .object({
    kind: z.enum(['document', 'file']),
    audienceType: z.enum(['company', 'branch', 'department', 'team'], { errorMap: () => ({ message: 'Choose who it’s for' }) }),
    audienceId: z.coerce.number().int().positive().optional().nullable(),
    title: z.string().trim().min(2, 'Give it a title').max(200),
    description: z.string().trim().max(500).optional().nullable(),
    body: z.string().max(500_000).optional(),
    notify: flag.optional().default(false),
  })
  .refine((d) => d.audienceType === 'company' || d.audienceId, { message: 'Choose the group', path: ['audienceId'] });

export const resourceUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  body: z.string().max(500_000).optional(),
});

export const sendSchema = z.object({
  email: z.boolean().default(false),
  message: z.string().trim().max(500).optional().nullable(),
});

export const resourceListSchema = z.object({
  search: z.string().trim().max(100).optional(),
});
