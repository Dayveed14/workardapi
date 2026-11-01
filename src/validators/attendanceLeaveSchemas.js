import { z } from 'zod';
import { dateString, optionalText, requiredId } from './common.js';

const coord = (min, max) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().min(min).max(max).nullable());

export const clockInSchema = z.object({
  latitude: coord(-90, 90).optional(),
  longitude: coord(-180, 180).optional(),
  accuracy: coord(0, 100000).optional(),
});

export const registerQuerySchema = z.object({
  date: dateString().optional(),
});

export const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM')
    .optional(),
});

export const leaveRequestSchema = z.object({
  leaveTypeId: requiredId('Choose a leave type'),
  startDate: dateString('Choose a start date'),
  endDate: dateString('Choose an end date'),
  reason: optionalText(500),
});

export const leaveListSchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional()),
});
