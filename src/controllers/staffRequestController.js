import * as requestSettingsService from '../services/requestSettingsService.js';
import asyncHandler from '../utils/asyncHandler.js';
import * as staffRequestService from '../services/staffRequestService.js';
import * as feedbackService from '../services/feedbackService.js';

// ---------- Salary advances & loans ----------
// GET /api/requests?view=mine|approvals|payouts
export const list = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.listRequests(req.auth, req.validatedQuery.view));
});

// GET /api/requests/limits  (how much I can ask for)
export const limits = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.myLimits(req.auth));
});

// POST /api/requests  { type, amount (naira), reason }
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await staffRequestService.createRequest(req.auth, req.body));
});

// GET /api/requests/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.getRequest(req.auth, req.params.id));
});

// PATCH /api/requests/:id/decision  { decision, note }
export const decide = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.decide(req.auth, req.params.id, req.body));
});

// POST /api/requests/:id/paid-out
export const paidOut = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.markPaidOut(req.auth, req.params.id));
});

// POST /api/requests/:id/cancel
export const cancel = asyncHandler(async (req, res) => {
  res.json(await staffRequestService.cancel(req.auth, req.params.id));
});

// ---------- Feedback, complaints, suggestions ----------
// POST /api/requests/feedback  { category, subject, body, isAnonymous }
export const sendFeedback = asyncHandler(async (req, res) => {
  res.status(201).json(await feedbackService.send(req.auth, req.body));
});

// GET /api/requests/feedback/mine
export const myFeedback = asyncHandler(async (req, res) => {
  res.json(await feedbackService.listMine(req.auth));
});

// GET /api/requests/feedback/inbox?status=  (feedback.manage)
export const feedbackInbox = asyncHandler(async (req, res) => {
  res.json(await feedbackService.listInbox(req.auth, req.validatedQuery));
});

// GET /api/requests/feedback/:id
export const getFeedback = asyncHandler(async (req, res) => {
  res.json(await feedbackService.getOne(req.auth, req.params.id));
});

// POST /api/requests/feedback/:id/replies  { body, status? }
export const replyFeedback = asyncHandler(async (req, res) => {
  res.json(await feedbackService.reply(req.auth, req.params.id, req.body));
});

// GET /api/requests/feedback/private/:token  (anonymous sender's private link)
export const feedbackByToken = asyncHandler(async (req, res) => {
  res.json(await feedbackService.getByToken(req.auth, req.params.token));
});

// POST /api/requests/feedback/private/:token/replies  { body }
export const replyByToken = asyncHandler(async (req, res) => {
  res.json(await feedbackService.replyByToken(req.auth, req.params.token, req.body));
});

// ---------- Settings → Loans & advances ----------
export const getSettings = asyncHandler(async (req, res) => {
  res.json({ ...(await requestSettingsService.getRules(req.auth.orgId)), defaults: requestSettingsService.defaults() });
});
export const updateSettings = asyncHandler(async (req, res) => {
  res.json({ ...(await requestSettingsService.updateRules(req.auth, req.body)), defaults: requestSettingsService.defaults() });
});
export const resetSettings = asyncHandler(async (req, res) => {
  res.json({ ...(await requestSettingsService.resetRules(req.auth)), defaults: requestSettingsService.defaults() });
});
