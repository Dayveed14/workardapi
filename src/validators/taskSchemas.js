import { z } from 'zod';
import { optionalText, optionalId, optionalDate, requiredId, dateString } from './common.js';

const priority = z.enum(['low', 'normal', 'high', 'urgent']).default('normal');

export const createTaskSchema = z.object({
  title: z.string({ required_error: 'Give the task a title' }).trim().min(2, 'Give the task a title').max(200),
  description: optionalText(5000),
  assignedEmployeeId: optionalId, // empty → the person creating it
  dueDate: optionalDate,
  priority,
  customerId: optionalId,
  projectId: optionalId,
  assigneeIds: z.array(z.coerce.number().int().positive()).max(20).optional(), // several people (first = lead)
  checklist: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
});

export const updateTaskSchema = z.object({
  title: z.string().trim().min(2, 'Give the task a title').max(200).optional(),
  description: optionalText(5000),
  assignedEmployeeId: optionalId,
  dueDate: optionalDate,
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  // left out = unchanged; "" or null = take it out of its project
  projectId: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().positive().nullable().optional()),
  assigneeIds: z.array(z.coerce.number().int().positive()).min(1).max(20).optional(),
});

export const statusSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled'], { errorMap: () => ({ message: 'Choose a status' }) }),
});

export const listTasksSchema = z.object({
  view: z.enum(['mine', 'team', 'created']).default('mine'),
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['open', 'todo', 'in_progress', 'done', 'cancelled']).optional()),
  due: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['overdue', 'today', 'week']).optional()),
  assigneeId: optionalId,
  customerId: optionalId,
  projectId: optionalId,
  search: optionalText(100),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const checklistItemSchema = z.object({
  text: z.string({ required_error: 'Write the checklist item' }).trim().min(1, 'Write the checklist item').max(255),
});

export const checklistToggleSchema = z.object({ isDone: z.boolean() });

export const commentSchema = z.object({
  body: z.string({ required_error: 'Write a comment' }).trim().min(1, 'Write a comment').max(3000),
});

export const recurringTaskSchema = z
  .object({
    title: z.string({ required_error: 'Give the task a title' }).trim().min(2, 'Give the task a title').max(200),
    description: optionalText(5000),
    assignedEmployeeId: requiredId('Choose who does it'),
    priority,
    frequency: z.enum(['daily', 'weekly', 'monthly'], { errorMap: () => ({ message: 'Choose how often' }) }),
    weekday: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(1).max(7).nullable().optional()),
    monthDay: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(1).max(31).nullable().optional()),
    startsOn: dateString().optional(),
    isActive: z.boolean().default(true),
  })
  .refine((d) => d.frequency !== 'weekly' || d.weekday, { message: 'Choose the day of the week', path: ['weekday'] })
  .refine((d) => d.frequency !== 'monthly' || d.monthDay, { message: 'Choose the day of the month', path: ['monthDay'] });
