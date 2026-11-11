import { z } from 'zod';
import { email, optionalId, optionalText } from './common.js';

// Mail: sending, replying, templates, signature, lists

const recipient = z.object({ email, name: optionalText(150) });
const recipients = z.array(recipient).max(50, 'An email can go to at most 50 people').default([]);

const message = {
  to: recipients,
  cc: recipients,
  bcc: recipients,
  html: z.string({ required_error: 'Write a message' }).max(200_000, 'The message is too long'),
  customerId: optionalId,
  requestId: z.string().trim().max(64).optional(), // the composer's id: a double click sends once
};

export const sendSchema = z.object({
  ...message,
  subject: z.string({ required_error: 'Add a subject' }).trim().min(1, 'Add a subject').max(300),
  employeeId: optionalId,
  invoiceId: optionalId,
});

export const replySchema = z.object({
  ...message,
  mode: z.enum(['reply', 'reply_all', 'forward']).default('reply'),
  subject: z.string().trim().max(300).optional(),
});

export const connectSchema = z.object({ withInbox: z.boolean().default(false) });

export const signatureSchema = z.object({ signatureHtml: z.string().max(10_000).default('') });

export const templateSchema = z.object({
  name: z.string({ required_error: 'Name the template' }).trim().min(2, 'Name the template').max(120),
  subject: z.string({ required_error: 'Add a subject' }).trim().min(1, 'Add a subject').max(300),
  bodyHtml: z.string({ required_error: 'Write the message' }).min(1, 'Write the message').max(100_000),
  isShared: z.boolean().default(false),
});

export const fillSchema = z.object({ customerId: optionalId, invoiceId: optionalId, employeeId: optionalId });

export const listSchema = z.object({
  box: z.enum(['sent', 'received', 'all']).default('all'),
  customerId: optionalId,
  employeeId: optionalId,
  invoiceId: optionalId,
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export const inboxSchema = z.object({
  search: z.string().trim().max(200).optional(),
  pageToken: z.string().trim().max(500).optional(),
});

export const contactsSchema = z.object({ search: z.string().trim().max(100).default('') });
