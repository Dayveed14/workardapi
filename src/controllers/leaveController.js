import asyncHandler from '../utils/asyncHandler.js';
import * as leaveService from '../services/leaveService.js';

// GET /api/leave?status=pending  (requests from people in my scope)
export const list = asyncHandler(async (req, res) => {
  res.json(await leaveService.listRequests(req.auth, req.scope, req.validatedQuery));
});

// PATCH /api/leave/:id/review  { decision, note }
export const review = asyncHandler(async (req, res) => {
  res.json(await leaveService.reviewLeave(req.auth, req.params.id, req.body));
});

// ----- Self-service (mounted under /api/me) -----

// GET /api/me/leave → { requests, balances }
export const myLeave = asyncHandler(async (req, res) => {
  res.json(await leaveService.myLeave(req.auth));
});

// POST /api/me/leave
export const request = asyncHandler(async (req, res) => {
  res.status(201).json(await leaveService.requestLeave(req.auth, req.body));
});

// POST /api/me/leave/:id/cancel
export const cancel = asyncHandler(async (req, res) => {
  res.json(await leaveService.cancelLeave(req.auth, req.params.id));
});
