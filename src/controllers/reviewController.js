import asyncHandler from '../utils/asyncHandler.js';
import * as reviewService from '../services/reviewService.js';

// GET /api/reviews/settings  (criteria + how often; everyone can read it)
export const getSettings = asyncHandler(async (req, res) => {
  res.json(await reviewService.getSettings(req.auth.orgId));
});

// PUT /api/reviews/settings
export const updateSettings = asyncHandler(async (req, res) => {
  res.json(await reviewService.updateSettings(req.auth, req.body));
});

// GET /api/reviews?view=mine|team&period=&status=&employeeId=
export const list = asyncHandler(async (req, res) => {
  res.json(await reviewService.listReviews(req.auth, req.validatedQuery));
});

// GET /api/reviews/reviewables?period=  (people I review + their review for the period)
export const reviewables = asyncHandler(async (req, res) => {
  res.json(await reviewService.listReviewables(req.auth, req.validatedQuery.period));
});

// POST /api/reviews/start  { period, employeeIds }
export const start = asyncHandler(async (req, res) => {
  res.status(201).json(await reviewService.startReviews(req.auth, req.body));
});

// GET /api/reviews/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await reviewService.getReview(req.auth, req.params.id));
});

// PUT /api/reviews/:id/self
export const saveSelf = asyncHandler(async (req, res) => {
  res.json(await reviewService.saveSelfReview(req.auth, req.params.id, req.body));
});

// POST /api/reviews/:id/skip-self
export const skipSelf = asyncHandler(async (req, res) => {
  res.json(await reviewService.skipSelfReview(req.auth, req.params.id));
});

// PUT /api/reviews/:id/manager
export const saveManager = asyncHandler(async (req, res) => {
  res.json(await reviewService.saveManagerReview(req.auth, req.params.id, req.body));
});

// POST /api/reviews/:id/acknowledge
export const acknowledge = asyncHandler(async (req, res) => {
  res.json(await reviewService.acknowledge(req.auth, req.params.id, req.body));
});

// POST /api/reviews/:id/cancel
export const cancel = asyncHandler(async (req, res) => {
  res.json(await reviewService.cancelReview(req.auth, req.params.id));
});
