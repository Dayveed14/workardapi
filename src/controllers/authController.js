import asyncHandler from '../utils/asyncHandler.js';
import * as authService from '../services/authService.js';
import AppError from '../utils/AppError.js';

// POST /api/auth/register → creates account, emails code → { requiresOtp, challengeToken, email }
export const register = asyncHandler(async (req, res) => {
  res.status(201).json(await authService.register(req.body));
});

// POST /api/auth/login → checks password, emails code → { requiresOtp, challengeToken, email }
export const login = asyncHandler(async (req, res) => {
  res.json(await authService.login(req.body));
});

// POST /api/auth/verify-otp → checks code, sets cookies → session
export const verifyOtp = asyncHandler(async (req, res) => {
  res.json(await authService.verifyOtp(req, res, req.body));
});

// POST /api/auth/resend-otp
export const resendOtp = asyncHandler(async (req, res) => {
  res.json(await authService.resendOtp(req.body));
});

// POST /api/auth/forgot-password
export const forgotPassword = asyncHandler(async (req, res) => {
  res.json(await authService.forgotPassword(req.body));
});

// POST /api/auth/reset-password
export const resetPassword = asyncHandler(async (req, res) => {
  res.json(await authService.resetPassword(req.body));
});

// POST /api/auth/refresh
export const refresh = asyncHandler(async (req, res) => {
  res.json(await authService.refresh(req, res));
});

// POST /api/auth/logout
export const logout = asyncHandler(async (req, res) => {
  res.json(await authService.logout(req, res));
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  const session = await authService.buildSession(req.auth.userId, req.auth.orgId);
  if (!session) throw new AppError(401, 'Not authenticated');
  res.json(session);
});

// POST /api/auth/switch-organization
export const switchOrganization = asyncHandler(async (req, res) => {
  res.json(await authService.switchOrganization(req, res, req.body.organizationId));
});
