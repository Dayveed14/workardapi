import * as reviewModel from '../models/reviewModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as attendanceModel from '../models/attendanceModel.js';
import * as leaveModel from '../models/leaveModel.js';
import * as taskModel from '../models/taskModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { withTransaction } from '../config/db.js';
import { sendEmail, reviewEmail } from './emailService.js';
import { managedCondition } from '../utils/scope.js';
import { toDateString, countWorkingDays, periodRange, periodFor } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// PERFORMANCE REVIEWS
//
//   self_review ──► manager_review ──► acknowledgement ──► completed
//   (employee rates   (manager rates,     (employee reads it,
//    themselves —      writes summary      adds a comment,
//    optional)         & goals)            confirms)
//   Any step before "completed" can be cancelled by the manager.
//
// Who is the "manager" of a review? Anyone whose `reviews.manage` scope
// covers the employee, or the employee's direct manager ("Reports to").
// Nobody can write their OWN manager review.
//
// The employee never sees the manager's ratings before they are submitted,
// and the manager never sees the self-ratings before the employee submits them.
// ============================================================

const me = (auth) => auth.employee?.id ?? -1;

function visibleCondition(auth) {
  const viewer = managedCondition(auth.permissions['reviews.view'], auth.employee);
  const manager = managedCondition(auth.permissions['reviews.manage'], auth.employee);
  return { sql: `(e.id = ? OR ${viewer.sql} OR ${manager.sql})`, params: [me(auth), ...viewer.params, ...manager.params] };
}

async function canManageEmployee(auth, employeeId) {
  if (Number(employeeId) === me(auth)) return false;
  const condition = managedCondition(auth.permissions['reviews.manage'], auth.employee);
  return Boolean(await employeeModel.findInScope(auth.orgId, employeeId, condition));
}

async function getVisibleReview(auth, id) {
  const review = await reviewModel.findVisible(auth.orgId, id, visibleCondition(auth));
  if (!review) throw new AppError(404, 'Review not found');
  return review;
}

// Weighted score out of 5, e.g. 3.85
function weightedScore(scores, field) {
  const rated = scores.filter((s) => s[field]);
  const totalWeight = rated.reduce((sum, s) => sum + s.weight, 0);
  if (!totalWeight) return null;
  const total = rated.reduce((sum, s) => sum + s[field] * s.weight, 0);
  return Math.round((total / totalWeight) * 100) / 100;
}

// The facts shown beside the ratings: attendance, leave and tasks for the period (up to today)
export async function buildFacts(employeeId, periodStart, periodEnd) {
  const today = toDateString();
  const to = periodEnd < today ? periodEnd : today;
  if (to < periodStart) return null; // period hasn't started yet

  const [attendance, leaves, tasks] = await Promise.all([
    attendanceModel.statsForEmployee(employeeId, periodStart, to),
    leaveModel.listApprovedInRange(employeeId, periodStart, to),
    taskModel.statsForEmployee(employeeId, periodStart, to),
  ]);
  const workingDays = countWorkingDays(periodStart, to);
  const leaveDays = leaves.reduce((sum, l) => {
    const s = l.start_date > periodStart ? l.start_date : periodStart;
    const e = l.end_date < to ? l.end_date : to;
    return sum + countWorkingDays(s, e);
  }, 0);

  return {
    upTo: to,
    workingDays,
    ...attendance,
    leaveDays,
    // Not clocked in and not on leave (can include public holidays)
    absentDays: Math.max(0, workingDays - attendance.daysPresent - leaveDays),
    tasks,
  };
}

const reviewLink = (id) => `${env.clientUrls[0]}/reviews/${id}`;

async function emailEmployee(orgId, review, stage) {
  const employee = await employeeModel.findById(orgId, review.employee_id);
  if (!employee?.email) return;
  const org = await organizationModel.findById(orgId);
  try {
    await sendEmail({
      to: employee.email,
      ...reviewEmail({ firstName: employee.first_name, businessName: org.name, period: review.period, stage, link: reviewLink(review.id) }),
    });
  } catch (err) {
    console.error('Review email failed:', err.message);
  }
}

// ---------- Settings ----------
export async function getSettings(orgId) {
  await reviewModel.ensureDefaults(orgId);
  const [settings, criteria] = await Promise.all([reviewModel.getSettings(orgId), reviewModel.listCriteria(orgId)]);
  return {
    frequency: settings.frequency,
    selfReview: !!settings.self_review,
    currentPeriod: periodFor(toDateString(), settings.frequency),
    criteria,
  };
}

export async function updateSettings(auth, data) {
  await withTransaction(async (db) => {
    await reviewModel.updateSettings(auth.orgId, data, db);
    await reviewModel.saveCriteria(auth.orgId, data.criteria, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'review_settings.updated' });
  return getSettings(auth.orgId);
}

// ---------- Lists ----------
export async function listReviews(auth, query) {
  const filters = { ...query };
  if (query.view === 'mine') filters.employeeId = me(auth);
  const rows = await reviewModel.list(auth.orgId, visibleCondition(auth), filters);
  // Lists only need who/when/score — never the written parts (they may be unfinished drafts)
  return rows.map(({ self_summary, manager_summary, goals, employee_comment, facts, ...row }) => row); // eslint-disable-line no-unused-vars
}

// Everyone this person can review, with their review for the period (if started)
export async function listReviewables(auth, period) {
  const condition = managedCondition(auth.permissions['reviews.manage'], auth.employee);
  const { rows } = await employeeModel.list(
    auth.orgId,
    { sql: `(${condition.sql}) AND e.id <> ?`, params: [...condition.params, me(auth)] },
    { status: 'active', limit: 500, offset: 0 }
  );
  const existing = new Map((await reviewModel.activeForPeriod(auth.orgId, period)).map((r) => [r.employee_id, r]));
  return rows.map((e) => ({
    id: e.id,
    first_name: e.first_name,
    last_name: e.last_name,
    job_title: e.job_title,
    department_name: e.department_name,
    review: existing.get(e.id) || null,
  }));
}

export async function countWaiting(auth) {
  return reviewModel.countWaiting(auth.orgId, me(auth), managedCondition(auth.permissions['reviews.manage'], auth.employee));
}

// ---------- Starting reviews ----------
export async function startReviews(auth, { period, employeeIds }) {
  const settings = await getSettings(auth.orgId);
  const isQuarter = period.includes('Q');
  if (isQuarter !== (settings.frequency === 'quarterly')) {
    throw new AppError(422, `Reviews are ${settings.frequency} — choose a ${isQuarter ? 'month' : 'quarter'}`, { period: 'Wrong kind of period' });
  }
  if (!settings.criteria.length) throw new AppError(409, 'Add review criteria in Settings → Reviews first');

  const { from, to } = periodRange(period);
  const status = settings.selfReview ? 'self_review' : 'manager_review';
  const created = [];
  const skipped = [];

  for (const employeeId of [...new Set(employeeIds)]) {
    if (!(await canManageEmployee(auth, employeeId))) {
      skipped.push({ employeeId, reason: 'not someone you review' });
      continue;
    }
    try {
      const id = await withTransaction(async (db) => {
        const reviewId = await reviewModel.create(
          auth.orgId,
          { employeeId, period, periodStart: from, periodEnd: to, status, createdBy: auth.userId },
          db
        );
        for (const c of settings.criteria) await reviewModel.addScore(reviewId, c, db);
        return reviewId;
      });
      created.push(id);
      if (status === 'self_review') await emailEmployee(auth.orgId, { id, employee_id: employeeId, period }, 'self_review');
    } catch (err) {
      // UNIQUE(employee_id, active_key): already has a live review for this period
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      skipped.push({ employeeId, reason: 'already started' });
    }
  }

  if (created.length) {
    await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'reviews.started', details: `${period}: ${created.length} review(s)` });
  }
  return { created: created.length, skipped, ids: created };
}

// ---------- One review ----------
export async function getReview(auth, id) {
  const review = await getVisibleReview(auth, id);
  const isEmployee = review.employee_id === me(auth);
  const isManager = await canManageEmployee(auth, review.employee_id);
  const scores = await reviewModel.listScores(id);

  // Hide what the other side hasn't submitted yet
  const managerDone = ['acknowledgement', 'completed'].includes(review.status);
  const selfDone = review.status !== 'self_review';
  const hideManager = !managerDone && !isManager;
  const hideSelf = !selfDone && !isEmployee;

  const facts = review.facts ? JSON.parse(review.facts) : await buildFacts(review.employee_id, review.period_start, review.period_end);

  return {
    ...review,
    facts,
    overall_score: hideManager ? null : review.overall_score,
    manager_summary: hideManager ? null : review.manager_summary,
    goals: hideManager ? null : review.goals,
    self_summary: hideSelf ? null : review.self_summary,
    scores: scores.map((s) => ({
      ...s,
      self_rating: hideSelf ? null : s.self_rating,
      manager_rating: hideManager ? null : s.manager_rating,
      comment: hideManager ? null : s.comment,
    })),
    selfScore: hideSelf ? null : weightedScore(scores, 'self_rating'),
    isEmployee,
    isManager,
    canSelfReview: isEmployee && review.status === 'self_review',
    canManagerReview: isManager && review.status === 'manager_review',
    canSkipSelf: isManager && review.status === 'self_review',
    canAcknowledge: isEmployee && review.status === 'acknowledgement',
    canCancel: isManager && !['completed', 'cancelled'].includes(review.status),
  };
}

function checkAllRated(scores, field) {
  if (scores.some((s) => !s[field])) throw new AppError(422, 'Rate every item (1–5) before submitting', { scores: 'Rate every item' });
}

export async function saveSelfReview(auth, id, data) {
  const review = await getVisibleReview(auth, id);
  if (review.employee_id !== me(auth)) throw new AppError(403, 'Only the person being reviewed can fill this in');

  await withTransaction(async (db) => {
    const locked = await reviewModel.lock(auth.orgId, id, db);
    if (locked.status !== 'self_review') throw new AppError(409, 'Your self-assessment has already been handed in');

    for (const s of data.scores) await reviewModel.setScore(id, s.id, { self_rating: s.rating ?? null }, db);
    const fields = { self_summary: data.summary ?? null };
    if (data.submit) {
      checkAllRated(await reviewModel.listScores(id, db), 'self_rating');
      Object.assign(fields, { status: 'manager_review', self_submitted_at: new Date() });
    }
    await reviewModel.update(id, fields, db);
  });
  return getReview(auth, id);
}

export async function skipSelfReview(auth, id) {
  const review = await getVisibleReview(auth, id);
  if (!(await canManageEmployee(auth, review.employee_id))) throw new AppError(403, 'You do not review this person');
  await withTransaction(async (db) => {
    const locked = await reviewModel.lock(auth.orgId, id, db);
    if (locked.status !== 'self_review') throw new AppError(409, 'This review is past the self-assessment step');
    await reviewModel.update(id, { status: 'manager_review' }, db);
  });
  return getReview(auth, id);
}

export async function saveManagerReview(auth, id, data) {
  const review = await getVisibleReview(auth, id);
  if (!(await canManageEmployee(auth, review.employee_id))) throw new AppError(403, 'You do not review this person');

  await withTransaction(async (db) => {
    const locked = await reviewModel.lock(auth.orgId, id, db);
    if (locked.status !== 'manager_review') {
      throw new AppError(409, locked.status === 'self_review' ? 'Waiting for the self-assessment (or skip it)' : 'This review has already been submitted');
    }

    for (const s of data.scores) {
      await reviewModel.setScore(id, s.id, { manager_rating: s.rating ?? null, comment: s.comment ?? null }, db);
    }
    const fields = { manager_summary: data.summary ?? null, goals: data.goals ?? null, reviewer_user_id: auth.userId };
    if (data.submit) {
      const scores = await reviewModel.listScores(id, db);
      checkAllRated(scores, 'manager_rating');
      // Freeze the facts as they were when the review was given
      const facts = await buildFacts(review.employee_id, review.period_start, review.period_end);
      Object.assign(fields, {
        status: 'acknowledgement',
        overall_score: weightedScore(scores, 'manager_rating'),
        facts: JSON.stringify(facts),
        manager_submitted_at: new Date(),
      });
    }
    await reviewModel.update(id, fields, db);
  });

  if (data.submit) {
    await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'review.submitted', entityType: 'employee', entityId: review.employee_id, details: review.period });
    await emailEmployee(auth.orgId, review, 'acknowledgement');
  }
  return getReview(auth, id);
}

export async function acknowledge(auth, id, { comment }) {
  const review = await getVisibleReview(auth, id);
  if (review.employee_id !== me(auth)) throw new AppError(403, 'Only the person being reviewed can confirm it');
  await withTransaction(async (db) => {
    const locked = await reviewModel.lock(auth.orgId, id, db);
    if (locked.status !== 'acknowledgement') throw new AppError(409, 'This review is not waiting for you');
    await reviewModel.update(id, { status: 'completed', employee_comment: comment ?? null, acknowledged_at: new Date() }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'review.acknowledged', entityType: 'employee', entityId: review.employee_id, details: review.period });
  return getReview(auth, id);
}

export async function cancelReview(auth, id) {
  const review = await getVisibleReview(auth, id);
  if (!(await canManageEmployee(auth, review.employee_id))) throw new AppError(403, 'You do not review this person');
  await withTransaction(async (db) => {
    const locked = await reviewModel.lock(auth.orgId, id, db);
    if (['completed', 'cancelled'].includes(locked.status)) throw new AppError(409, 'A finished review cannot be cancelled');
    // active_key = NULL frees the period, so a new review can be started
    await reviewModel.update(id, { status: 'cancelled', active_key: null }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'review.cancelled', entityType: 'employee', entityId: review.employee_id, details: review.period });
  return getReview(auth, id);
}
