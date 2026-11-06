import { z } from 'zod';
import { optionalDate } from './common.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour');

export const projectSchema = z
  .object({
    name: z.string().trim().min(2, 'Name the project').max(150),
    description: z.string().trim().max(1000).optional().nullable(),
    audienceType: z.enum(['company', 'branch', 'department', 'team'], { errorMap: () => ({ message: 'Choose whose project it is' }) }),
    audienceId: z.coerce.number().int().positive().optional().nullable(),
    color: color.default('#2a78d6'),
    dueDate: optionalDate,
  })
  .refine((d) => d.audienceType === 'company' || d.audienceId, { message: 'Choose the group', path: ['audienceId'] });

export const projectUpdateSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  color: color.optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  dueDate: optionalDate,
});

export const projectListSchema = z.object({
  status: z.enum(['active', 'completed', 'archived']).optional(),
});
