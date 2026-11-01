import crypto from 'node:crypto';
import { env } from '../config/env.js';
import * as otpModel from '../models/otpModel.js';
import { sendEmail, otpEmail } from './emailService.js';
import { addMinutes } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

const CODE_MINUTES = 10; // how long a code works
const RESEND_SECONDS = 60; // wait before another code can be sent
const MAX_ATTEMPTS = 5; // wrong guesses allowed per code

function hashCode(userId, purpose, code) {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${purpose}:${code}:${env.jwt.accessSecret}`)
    .digest('hex');
}

// Sends a 6-digit code by email.
// If a code was sent less than 60s ago:
//   - reuseRecent = true  → do nothing (the earlier code still works)
//   - reuseRecent = false → tell the user to wait
export async function sendCode(user, purpose, { reuseRecent = false } = {}) {
  const now = new Date();
  const latest = await otpModel.findLatest(user.id, purpose);

  if (latest) {
    const secondsSince = (now - new Date(latest.created_at.replace(' ', 'T'))) / 1000;
    if (secondsSince < RESEND_SECONDS) {
      if (reuseRecent) return;
      throw new AppError(429, `Please wait ${Math.ceil(RESEND_SECONDS - secondsSince)} seconds before requesting a new code`);
    }
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await otpModel.invalidateAll(user.id, purpose, now);
  await otpModel.create({
    userId: user.id,
    purpose,
    codeHash: hashCode(user.id, purpose, code),
    expiresAt: addMinutes(now, CODE_MINUTES),
    createdAt: now,
  });

  await sendEmail({ to: user.email, ...otpEmail(code, purpose) });
}

// Checks a code. Throws a friendly error if it is wrong, expired or used up.
export async function verifyCode(userId, purpose, code) {
  const now = new Date();
  const otp = await otpModel.findLatest(userId, purpose);

  if (!otp || new Date(otp.expires_at.replace(' ', 'T')) < now) {
    throw new AppError(400, 'This code has expired. Request a new one.', { code: 'Code expired' });
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new AppError(429, 'Too many wrong attempts. Request a new code.', { code: 'Too many attempts' });
  }

  const expected = Buffer.from(otp.code_hash, 'hex');
  const given = Buffer.from(hashCode(userId, purpose, String(code).trim()), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    await otpModel.addAttempt(otp.id);
    throw new AppError(400, 'That code is incorrect', { code: 'Incorrect code' });
  }

  await otpModel.markUsed(otp.id, now);
}
