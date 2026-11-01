import asyncHandler from '../utils/asyncHandler.js';
import * as inviteService from '../services/inviteService.js';

// GET /api/invites/:token (public)
export const getInvite = asyncHandler(async (req, res) => {
  res.json(await inviteService.getInvite(req.params.token));
});

// POST /api/invites/:token/accept (public) → logs the person in
export const acceptInvite = asyncHandler(async (req, res) => {
  res.json(await inviteService.acceptInvite(req, res, req.params.token, req.body));
});

// POST /api/employees/:id/invite
export const sendInvite = asyncHandler(async (req, res) => {
  res.json(await inviteService.sendInvite(req.auth, req.params.id, req.body.roleId));
});
