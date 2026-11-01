import crypto from 'node:crypto';
import asyncHandler from '../utils/asyncHandler.js';
import { runDailyJobs } from '../services/schedulerService.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// POST /api/jobs/daily   header: x-cron-secret
// For hosts that sleep: an outside cron service wakes the server and runs the daily jobs.
// Running it more than once is harmless (see schedulerService).
export const daily = asyncHandler(async (req, res) => {
  const given = Buffer.from(String(req.get('x-cron-secret') || ''));
  const expected = Buffer.from(env.cronSecret);
  if (!env.cronSecret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AppError(401, 'Not allowed');
  }
  res.json(await runDailyJobs());
});
