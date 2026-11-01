import { z } from 'zod';
import { email, optionalText, optionalPhone, optionalId, optionalDate, requiredId } from './common.js';

const employeeFields = {
  staffId: optionalText(40),
  firstName: z.string({ required_error: 'First name is required' }).trim().min(1, 'First name is required').max(80),
  lastName: z.string({ required_error: 'Last name is required' }).trim().min(1, 'Last name is required').max(80),
  email,
  phone: optionalPhone,
  gender: z.preprocess((v) => (v === '' ? null : v), z.enum(['male', 'female', 'other']).nullable().optional()),
  dateOfBirth: optionalDate,
  address: optionalText(255),
  jobTitle: optionalText(120),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).default('full_time'),
  branchId: optionalId,
  departmentId: optionalId,
  teamId: optionalId,
  managerId: optionalId,
  startDate: optionalDate,
  emergencyContactName: optionalText(120),
  emergencyContactPhone: optionalPhone,
};

export const createEmployeeSchema = z
  .object({
    ...employeeFields,
    sendInvite: z.boolean().optional().default(false),
    roleId: optionalId,
  })
  .refine((d) => !d.sendInvite || d.roleId, { message: 'Choose a role for the invite', path: ['roleId'] });

export const updateEmployeeSchema = z.object(employeeFields).partial();

export const listEmployeesSchema = z.object({
  search: optionalText(100),
  branchId: optionalId,
  departmentId: optionalId,
  teamId: optionalId,
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['active', 'exited']).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const exitEmployeeSchema = z.object({ exitDate: optionalDate });

export const inviteSchema = z.object({ roleId: requiredId('Choose a role') });

export const assignRoleSchema = z.object({ roleId: requiredId('Choose a role') });

export const documentSchema = z.object({
  title: z.string({ required_error: 'Title is required' }).trim().min(1, 'Title is required').max(160),
  category: z
    .enum(['contract', 'identification', 'certificate', 'offer_letter', 'medical', 'other'])
    .default('other'),
});
