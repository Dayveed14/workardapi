import { z } from 'zod';
import { dateString } from './common.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a time');

const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
// Weekly: which days, each with its own start time (0 = Sunday … 6 = Saturday)
const repeatDays = z
  .array(z.object({ day: z.coerce.number().int().min(0).max(6), time }))
  .max(7)
  .refine((days) => new Set(days.map((d) => d.day)).size === days.length, 'Each day only once');
const repeatEvery = z.coerce.number().int().min(1, 'At least 1').max(12, 'At most 12');

export const meetingSchema = z
  .object({
    title: z.string().trim().min(2, 'Give the meeting a name').max(200),
    description: z.string().trim().max(1000).optional().nullable(),
    audienceType: z.enum(['people', 'company', 'branch', 'department', 'team']).default('people'),
    audienceId: z.coerce.number().int().positive().optional().nullable(),
    inviteeIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    projectId: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().positive().nullable().optional()),
    date: dateString(),
    time,
    durationMinutes: z.coerce.number().int().min(5).max(480).default(30),
    repeat: z.enum(REPEATS).default('none'),
    repeatEvery: repeatEvery.default(1),
    repeatDays: repeatDays.default([]),
    repeatUntil: z.preprocess((v) => (v === '' ? null : v), dateString().nullable().optional()),
    isStandup: z.boolean().default(false),
  })
  .refine((d) => ['people', 'company'].includes(d.audienceType) || d.audienceId, { message: 'Choose the group', path: ['audienceId'] })
  .refine((d) => d.repeat !== 'weekly' || d.repeatDays.length > 0, { message: 'Pick at least one day', path: ['repeatDays'] })
  .refine((d) => !d.repeatUntil || d.repeatUntil >= d.date, { message: 'Must be after the first date', path: ['repeatUntil'] });

export const meetingUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  inviteeIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
  date: dateString().optional(),
  time: time.optional(),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  repeat: z.enum(REPEATS).optional(),
  repeatEvery: repeatEvery.optional(),
  repeatDays: repeatDays.optional(),
  repeatUntil: z.preprocess((v) => (v === '' ? null : v), dateString().nullable().optional()),
  isStandup: z.boolean().optional(),
});

export const rangeSchema = z.object({ from: dateString(), to: dateString() }).refine((d) => d.from <= d.to, { message: 'from must be before to', path: ['to'] });

export const skipSchema = z.object({ date: dateString() });

export const occurrenceSchema = z.object({ date: dateString().optional() });
