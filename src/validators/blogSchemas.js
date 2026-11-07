import { z } from 'zod';
import { optionalText } from './common.js';

const dateTime = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v === null ? null : new Date(v)),
  z.date({ invalid_type_error: 'Enter a valid date and time' }).nullable().optional()
);

const post = {
  title: z.string().trim().min(3, 'Give the post a title').max(200),
  slug: z.string().trim().max(160).regex(/^[a-z0-9-]*$/, 'Only small letters, numbers and dashes').optional(),
  excerpt: optionalText(400),
  bodyHtml: z.string().max(3_000_000, 'This post is too long — use smaller images'),
  coverUrl: z.string().trim().max(500).optional().nullable(),
  category: optionalText(60),
  seoTitle: optionalText(200),
  seoDescription: optionalText(300),
  status: z.enum(['draft', 'published']).default('draft'),
  publishedAt: dateTime,
};

export const blogPostSchema = z.object(post);
export const blogPostUpdateSchema = z.object(Object.fromEntries(Object.entries(post).map(([k, v]) => [k, k === 'status' ? z.enum(['draft', 'published']).optional() : v.optional()])));
export const blogListSchema = z.object({
  category: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
