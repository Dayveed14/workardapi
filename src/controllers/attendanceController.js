import asyncHandler from '../utils/asyncHandler.js';
import * as attendanceService from '../services/attendanceService.js';
import { getClientIp } from '../utils/ip.js';

// GET /api/attendance?date=2026-11-02  (daily register)
export const register = asyncHandler(async (req, res) => {
  res.json(await attendanceService.getRegister(req.auth, req.scope, req.validatedQuery.date));
});

// GET /api/attendance/flagged
export const flagged = asyncHandler(async (req, res) => {
  res.json(await attendanceService.listFlagged(req.auth));
});

// PATCH /api/attendance/:id/review  { decision: 'approved' | 'rejected', note }
export const review = asyncHandler(async (req, res) => {
  res.json(await attendanceService.reviewFlagged(req.auth, req.params.id, req.body));
});

// ----- Self-service (mounted under /api/me) -----

// GET /api/me/attendance/today
export const today = asyncHandler(async (req, res) => {
  res.json(await attendanceService.getToday(req.auth));
});

// POST /api/me/attendance/clock-in  { latitude, longitude, accuracy }
export const clockIn = asyncHandler(async (req, res) => {
  res.status(201).json(await attendanceService.clockIn(req.auth, req.body, getClientIp(req)));
});

// POST /api/me/attendance/clock-out
export const clockOut = asyncHandler(async (req, res) => {
  res.json(await attendanceService.clockOut(req.auth));
});

// GET /api/me/attendance?month=2026-11
export const myHistory = asyncHandler(async (req, res) => {
  res.json(await attendanceService.myHistory(req.auth, req.validatedQuery.month));
});

// GET /api/attendance/monthly?month=2026-11  (adherence for everyone in the viewer's scope)
export const monthly = asyncHandler(async (req, res) => {
  res.json(await attendanceService.getMonthly(req.auth, req.scope, req.validatedQuery.month));
});
