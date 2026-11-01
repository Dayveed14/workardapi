import { z } from 'zod';
import { optionalText, optionalId } from './common.js';

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a time like 08:00')
  .transform((t) => (t.length === 5 ? `${t}:00` : t));

const optionalNumber = (min, max) =>
  z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().min(min).max(max).nullable());

export const organizationSchema = z.object({
  name: z.string().trim().min(2, 'Enter the organisation name').max(160),
  industry: optionalText(80),
  size: optionalText(20),
});

export const branchSchema = z
  .object({
    name: z.string().trim().min(1, 'Branch name is required').max(120),
    address: optionalText(255),
    latitude: optionalNumber(-90, 90),
    longitude: optionalNumber(-180, 180),
    radiusM: z.coerce.number().int().min(20, 'At least 20 m').max(5000, 'At most 5,000 m').default(150),
    officeIps: optionalText(500),
    clockInPolicy: z.enum(['none', 'location', 'wifi', 'either', 'both']).default('either'),
    workStart: time.default('08:00:00'),
    workEnd: time.default('17:00:00'),
    graceMinutes: z.coerce.number().int().min(0).max(240).default(15),
  })
  .refine((b) => (b.latitude === null) === (b.longitude === null), {
    message: 'Enter both latitude and longitude',
    path: ['longitude'],
  });

export const nameSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
});

export const teamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(120),
  departmentId: optionalId,
  supervisorEmployeeId: optionalId,
});

export const leaveTypeSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  daysPerYear: z.coerce.number().int().min(0).max(365),
  isPaid: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export const roleSchema = z.object({
  name: z.string().trim().min(2, 'Role name is required').max(80),
  description: optionalText(255),
  permissions: z.record(z.string()).default({}),
});
