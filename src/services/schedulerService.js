import * as blogModel from '../models/blogModel.js';
import { requestRebuild } from './deployHookService.js';
import { deleteOldRead } from '../models/notificationModel.js';
import { escalateUnansweredFlags } from './attendanceService.js';
import { pool } from '../config/db.js';
import * as taskModel from '../models/taskModel.js';
import { generateRecurringTasks } from './taskService.js';
import { sendEmail, taskDigestEmail } from './emailService.js';
import { env } from '../config/env.js';
import { toDateString } from '../utils/dates.js';

// ============================================================
// DAILY JOBS
//   1. make today's tasks from repeating tasks   (every check — safe to repeat)
//   2. email each person their tasks due/overdue (once per working day, after 7am)
//
// server.js runs `runDailyJobs()` at start-up and every 15 minutes.
// On hosts where the server sleeps (e.g. Render free), also call
//   POST /api/jobs/daily   with header  x-cron-secret: <CRON_SECRET>
// from a free cron service (cron-job.org) every morning.
// ============================================================

// Records that a job ran today. Returns false if it already did (on this or another server).
async function claimToday(jobName, today) {
  const [result] = await pool.query('INSERT IGNORE INTO job_runs (job_name, run_date) VALUES (?, ?)', [jobName, today]);
  return result.affectedRows === 1;
}

export async function sendTaskDigests(today = toDateString()) {
  const rows = await taskModel.listDueForDigest(today);

  // Group by person
  const people = new Map();
  for (const row of rows) {
    if (!row.email) continue;
    if (!people.has(row.employee_id)) people.set(row.employee_id, { ...row, dueToday: [], overdue: [] });
    const person = people.get(row.employee_id);
    (row.due_date < today ? person.overdue : person.dueToday).push(row);
  }

  let sent = 0;
  for (const p of people.values()) {
    try {
      await sendEmail({
        to: p.email,
        ...taskDigestEmail({
          firstName: p.first_name,
          businessName: p.organization_name,
          dueToday: p.dueToday,
          overdue: p.overdue,
          link: `${env.clientUrls[0]}/tasks`,
        }),
      });
      sent += 1;
    } catch (err) {
      console.error('Digest email failed:', err.message);
    }
  }
  return sent;
}

let lastBlogCheck = new Date();

export async function runDailyJobs(now = new Date()) {
  const today = toDateString(now);
  const result = { recurringCreated: 0, flagsEscalated: 0, digestsSent: null };

  result.recurringCreated = await generateRecurringTasks(today);
  // Flagged clock-ins nobody explained within 24 hours go to managers
  result.flagsEscalated = await escalateUnansweredFlags(now);
  // Read notifications older than 90 days are cleared
  result.notificationsCleared = await deleteOldRead(90);
  // Scheduled blog posts that went live since the last run → rebuild the website
  const wentLive = await blogModel.wentLiveSince(lastBlogCheck);
  lastBlogCheck = now;
  if (wentLive) result.websiteRebuild = requestRebuild('scheduled blog post went live');

  const weekday = now.getDay();
  const isWorkingDay = weekday !== 0 && weekday !== 6;
  if (isWorkingDay && now.getHours() >= 7 && (await claimToday('task_digest', today))) {
    result.digestsSent = await sendTaskDigests(today);
  }
  return result;
}

// Started from server.js (not during tests)
export function startScheduler() {
  const run = () =>
    runDailyJobs()
      .then((r) => {
        if (r.recurringCreated || r.digestsSent) console.log('⏰ Daily jobs:', r);
      })
      .catch((err) => console.error('Daily jobs failed:', err.message));
  run();
  setInterval(run, 15 * 60 * 1000);
}
