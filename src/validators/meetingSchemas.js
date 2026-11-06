import { z } from 'zod';
import { dateString } from './common.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a time');

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
    repeat: z.enum(['none', 'daily', 'weekdays', 'weekly']).default('none'),
    repeatUntil: z.preprocess((v) => (v === '' ? null : v), dateString().nullable().optional()),
    isStandup: z.boolean().default(false),
  })
  .refine((d) => ['people', 'company'].includes(d.audienceType) || d.audienceId, { message: 'Choose the group', path: ['audienceId'] });

export const meetingUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  inviteeIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
  date: dateString().optional(),
  time: time.optional(),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  repeat: z.enum(['none', 'daily', 'weekdays', 'weekly']).optional(),
  repeatUntil: z.preprocess((v) => (v === '' ? null : v), dateString().nullable().optional()),
  isStandup: z.boolean().optional(),
});

export const rangeSchema = z.object({ from: dateString(), to: dateString() }).refine((d) => d.from <= d.to, { message: 'from must be before to', path: ['to'] });

export const occurrenceSchema = z.object({ date: dateString().optional() });
