import { z } from 'zod';
import { optionalText, optionalPhone, optionalId, optionalDate } from './common.js';

const optionalEmail = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().trim().toLowerCase().email('Enter a valid email address').max(190).nullable().optional()
);

const customerFields = {
  type: z.enum(['individual', 'business']).default('individual'),
  name: z.string({ required_error: 'Name is required' }).trim().min(2, 'Enter the customer name').max(160),
  contactPerson: optionalText(120),
  email: optionalEmail,
  phone: optionalPhone,
  address: optionalText(255),
  stage: z.enum(['lead', 'prospect', 'customer', 'inactive']).default('lead'),
  source: optionalText(60),
  assignedEmployeeId: optionalId,
  notes: optionalText(5000),
};

export const createCustomerSchema = z.object(customerFields);

export const updateCustomerSchema = z.object(customerFields).partial();

export const listCustomersSchema = z.object({
  search: optionalText(100),
  stage: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['lead', 'prospect', 'customer', 'inactive']).optional()),
  assignedEmployeeId: optionalId,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const activitySchema = z.object({
  type: z.enum(['note', 'call', 'meeting', 'email', 'enquiry', 'complaint']).default('note'),
  subject: z.string({ required_error: 'Subject is required' }).trim().min(2, 'Add a short subject').max(160),
  details: optionalText(5000),
  followUpOn: optionalDate,
});
