import { z } from 'zod';
import { optionalText, optionalDate, requiredId, dateString } from './common.js';

export const resignSchema = z.object({ reason: optionalText(1000) });

// HR starts someone's exit: a resignation they received, or a termination (24 hours)
export const startSchema = z.object({
  employeeId: requiredId('Choose the person'),
  exitType: z.enum(['resignation', 'termination']),
  reason: optionalText(1000),
  lastDay: optionalDate,
  templateId: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().positive().nullable().optional()),
});

export const listSchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['open', 'notice', 'in_progress', 'exited', 'withdrawn', 'cancelled']).optional()),
});

export const checklistSchema = z.object({ templateId: requiredId('Choose a checklist') });
export const itemDoneSchema = z.object({ done: z.boolean(), note: optionalText(5000) });
export const addItemSchema = z.object({
  title: z.string({ required_error: 'Describe the item' }).trim().min(2, 'Describe the item').max(200),
  description: optionalText(500),
  owner: z.enum(['employee', 'hr']),
  dueDate: optionalDate,
  asksForNote: z.boolean().default(false),
});
export const lastDaySchema = z.object({ lastDay: dateString() });
export const noticeSchema = z.object({ noticeDays: z.coerce.number().int().min(0, '0 or more days').max(180, 'At most 180 days') });
