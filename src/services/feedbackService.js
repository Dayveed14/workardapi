import crypto from 'node:crypto';
import * as feedbackModel from '../models/feedbackModel.js';
import { pool } from '../config/db.js';
import { notify } from './notificationService.js';
import AppError from '../utils/AppError.js';

// ============================================================
// STAFF FEEDBACK — about my job, complaints, suggestions.
// Read & answered by people with feedback.manage (HR / the owner).
//
// ANONYMOUS really means anonymous:
//   - no employee id, no user id, no exact time is stored (just the day)
//   - nothing is written to the activity log with the sender's name
//   - the bell notification for HR says "Anonymous"
//   - the sender gets a private link (/feedback/<token>) to follow replies.
//     Only a SHA-256 hash of the token is stored, so nobody can work it back.
// ============================================================

const CATEGORY_NAMES = { job: 'feedback about their job', complaint: 'a complaint', suggestion: 'a suggestion' };
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function managers(orgId) {
  const [rows] = await pool.query(
    `SELECT m.user_id, r.is_owner, r.permissions FROM memberships m JOIN roles r ON r.id = m.role_id
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [orgId]
  );
  return rows.filter((r) => r.is_owner || JSON.parse(r.permissions || '{}')['feedback.manage']).map((r) => r.user_id);
}

export async function send(auth, { category, subject, body, isAnonymous }) {
  const token = isAnonymous ? crypto.randomBytes(24).toString('hex') : null;
  const id = await feedbackModel.create(auth.orgId, {
    category,
    subject,
    body,
    isAnonymous,
    employeeId: isAnonymous ? null : auth.employee?.id,
    userId: isAnonymous ? null : auth.userId,
    tokenHash: token ? hash(token) : null,
  });
  await notify(auth.orgId, await managers(auth.orgId), {
    type: 'feedback.new',
    title: `${isAnonymous ? 'Someone (anonymous)' : auth.userName} sent ${CATEGORY_NAMES[category]}: ${subject}`,
    link: `/requests?tab=feedback-inbox&open=${id}`,
    actorUserId: isAnonymous ? null : auth.userId,
  });
  const feedback = await feedbackModel.findById(auth.orgId, id);
  // The private link is shown once — the sender should keep it
  return { ...strip(feedback), privateLink: token ? `/feedback/${token}` : null };
}

// Never send who sent anonymous feedback (there's nothing stored, but be explicit)
const strip = ({ employee_id: _e, user_id: _u, ...f }) => f;

export async function listMine(auth) {
  return (await feedbackModel.list(auth.orgId, { userId: auth.userId })).map(strip);
}

export async function listInbox(auth, { status }) {
  return (await feedbackModel.list(auth.orgId, { status })).map(strip);
}

// Open one: managers see any; senders see their own (named) ones
export async function getOne(auth, id) {
  const feedback = await feedbackModel.findById(auth.orgId, id);
  if (!feedback || !(auth.permissions['feedback.manage'] || feedback.user_id === auth.userId)) {
    throw new AppError(404, 'Feedback not found');
  }
  return { ...strip(feedback), replies: await feedbackModel.replies(id), isSender: feedback.user_id === auth.userId };
}

// The anonymous sender's private link
export async function getByToken(auth, token) {
  const feedback = await feedbackModel.findByTokenHash(auth.orgId, hash(token));
  if (!feedback) throw new AppError(404, 'Feedback not found');
  return { ...strip(feedback), replies: await feedbackModel.replies(feedback.id), isSender: true };
}

export async function reply(auth, id, { body, status }) {
  const feedback = await feedbackModel.findById(auth.orgId, id);
  if (!feedback) throw new AppError(404, 'Feedback not found');
  const isManager = Boolean(auth.permissions['feedback.manage']);
  const isSender = feedback.user_id === auth.userId;
  if (!isManager && !isSender) throw new AppError(404, 'Feedback not found');

  if (body) {
    await feedbackModel.addReply(id, { fromSender: isSender && !isManager ? 1 : 0, userId: auth.userId, body });
  }
  if (status && isManager) await feedbackModel.setStatus(auth.orgId, id, status);
  else if (isManager && feedback.status === 'received') await feedbackModel.setStatus(auth.orgId, id, 'in_review');

  if (isManager && feedback.user_id) {
    await notify(auth.orgId, [feedback.user_id], {
      type: 'feedback.reply',
      title: `${auth.userName} replied to your ${feedback.category === 'complaint' ? 'complaint' : 'feedback'}: ${feedback.subject}`,
      link: `/requests?tab=feedback&open=${id}`,
      actorUserId: auth.userId,
    });
  } else if (isSender && !isManager) {
    await notify(auth.orgId, await feedbackModel.replierIds(id), {
      type: 'feedback.reply',
      title: `${auth.userName} answered on “${feedback.subject}”`,
      link: `/requests?tab=feedback-inbox&open=${id}`,
      actorUserId: auth.userId,
    });
  }
  return getOne(auth, id);
}

// The anonymous sender replies through their private link
export async function replyByToken(auth, token, { body }) {
  const feedback = await feedbackModel.findByTokenHash(auth.orgId, hash(token));
  if (!feedback) throw new AppError(404, 'Feedback not found');
  await feedbackModel.addReply(feedback.id, { fromSender: 1, userId: null, body });
  await notify(auth.orgId, await feedbackModel.replierIds(feedback.id), {
    type: 'feedback.reply',
    title: `The anonymous sender answered on “${feedback.subject}”`,
    link: `/requests?tab=feedback-inbox&open=${feedback.id}`,
  });
  return getByToken(auth, token);
}
