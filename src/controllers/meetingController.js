import asyncHandler from '../utils/asyncHandler.js';
import * as meetingService from '../services/meetingService.js';

// GET /api/meetings?from=YYYY-MM-DD&to=YYYY-MM-DD   (my calendar: every occurrence in the range)
export const range = asyncHandler(async (req, res) => {
  res.json(await meetingService.listRange(req.auth, req.validatedQuery));
});

// GET /api/meetings/groups   (groups I can schedule for)
export const groups = asyncHandler(async (req, res) => {
  res.json(await meetingService.schedulingGroups(req.auth));
});

// GET /api/meetings/people   (colleagues I can invite)
export const people = asyncHandler(async (req, res) => {
  res.json(await meetingService.inviteList(req.auth));
});

// POST /api/meetings
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await meetingService.createMeeting(req.auth, req.body));
});

// GET /api/meetings/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await meetingService.getMeeting(req.auth, req.params.id));
});

// PATCH /api/meetings/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await meetingService.updateMeeting(req.auth, req.params.id, req.body));
});

// DELETE /api/meetings/:id   (cancels it and tells everyone)
export const cancel = asyncHandler(async (req, res) => {
  await meetingService.cancelMeeting(req.auth, req.params.id);
  res.status(204).end();
});

// POST /api/meetings/:id/join?date=   → { url, token, room }  (LiveKit)
export const join = asyncHandler(async (req, res) => {
  res.json(await meetingService.join(req.auth, req.params.id, req.validatedQuery.date));
});

// GET /api/meetings/:id/standup?date=
export const standup = asyncHandler(async (req, res) => {
  res.json(await meetingService.standup(req.auth, req.params.id, req.validatedQuery.date));
});

// POST /api/meetings/:id/skip { date } — cancel just that date of a repeating meeting
export const skip = asyncHandler(async (req, res) => {
  res.json(await meetingService.skipDate(req.auth, req.params.id, req.body.date, true));
});

// DELETE /api/meetings/:id/skip?date= — bring a cancelled date back
export const unskip = asyncHandler(async (req, res) => {
  res.json(await meetingService.skipDate(req.auth, req.params.id, req.validatedQuery.date, false));
});
