import { z } from 'zod';
import { email, password, optionalPhone, optionalText, otpCode } from './common.js';

export const registerSchema = z.object({
  fullName: z.string({ required_error: 'Full name is required' }).trim().min(2, 'Enter your full name').max(120),
  organizationName: z
    .string({ required_error: 'Business name is required' })
    .trim()
    .min(2, 'Enter your business name')
    .max(160),
  email,
  phone: optionalPhone,
  password,
  industry: optionalText(80),
  size: optionalText(20),
});

export const loginSchema = z.object({
  email,
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
});

export const verifyOtpSchema = z.object({
  challengeToken: z.string().min(10, 'Verification expired'),
  code: otpCode,
});

export const resendOtpSchema = z.object({
  challengeToken: z.string().min(10, 'Verification expired'),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  challengeToken: z.string().min(10, 'Reset expired'),
  code: otpCode,
  password,
});

export const switchOrganizationSchema = z.object({
  organizationId: z.coerce.number().int().positive(),
});

export const acceptInviteSchema = z.object({
  fullName: optionalText(120),
  password: z.string().min(1, 'Password is required').max(72),
});
