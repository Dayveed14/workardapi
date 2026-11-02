import { z } from 'zod';
import { optionalText, optionalDate, requiredId } from './common.js';

const owner = z.enum(['new_joiner', 'hr'], { errorMap: () => ({ message: 'Choose who does it' }) });

export const templateSchema = z.object({
  name: z.string({ required_error: 'Name the checklist' }).trim().min(2, 'Name the checklist').max(120),
  description: optionalText(255),
  suits: z.enum(['everyone', 'staff', 'managers']).default('everyone'),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(2, 'Describe each item').max(200),
        description: optionalText(500),
        owner,
        dueDay: z.coerce.number().int().min(0, 'Use 0 or more days').max(365).default(0),
      })
    )
    .min(1, 'Add at least one item')
    .max(60),
});

export const startSchema = z.object({
  employeeId: requiredId('Choose the new joiner'),
  templateId: requiredId('Choose a checklist'),
  startDate: optionalDate,
});

export const listSchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['in_progress', 'completed', 'cancelled']).optional()),
});

export const itemDoneSchema = z.object({ done: z.boolean() });

export const addItemSchema = z.object({
  title: z.string({ required_error: 'Describe the item' }).trim().min(2, 'Describe the item').max(200),
  description: optionalText(500),
  owner,
  dueDate: optionalDate,
});
