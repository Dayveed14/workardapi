import asyncHandler from '../utils/asyncHandler.js';
import * as platformSettingsService from '../services/platformSettingsService.js';
import * as adminService from '../services/adminService.js';
import * as blogService from '../services/blogService.js';
import * as supportService from '../services/supportService.js';
import AppError from '../utils/AppError.js';

// ---------- The website (no login) ----------
// GET /api/public/plans — today's prices and trial length (the home page reads these)
export const plans = asyncHandler(async (req, res) => {
  const { plans: list, trialDays, billingEnabled } = platformSettingsService.currentPricing();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ plans: list.map(({ id, name, prices }) => ({ id, name, prices })), trialDays, billingEnabled });
});

export const demoRequest = asyncHandler(async (req, res) => {
  if (req.body.website) return res.status(201).json({ message: 'Thanks!' }); // a bot filled the hidden field
  res.status(201).json(await adminService.createDemoRequest(req.body));
});

export const blogList = asyncHandler(async (req, res) => res.json(await blogService.listLive(req.validatedQuery)));
export const blogPost = asyncHandler(async (req, res) => res.json(await blogService.getLive(req.params.slug)));

// Everything the website build needs in one call (prerendering posts + prices)
export const build = asyncHandler(async (req, res) => {
  const { plans: list, trialDays, billingEnabled } = platformSettingsService.currentPricing();
  res.json({ plans: list.map(({ id, name, prices }) => ({ id, name, prices })), trialDays, billingEnabled, posts: await blogService.allLiveForBuild() });
});

// ---------- Owner: Workard support access ----------
const ownerOnly = (auth) => {
  if (!auth.role.isOwner) throw new AppError(403, 'Only the owner can let Workard support in');
};
export const supportStatus = asyncHandler(async (req, res) => {
  ownerOnly(req.auth);
  res.json(await supportService.status(req.auth));
});
export const supportGrant = asyncHandler(async (req, res) => {
  ownerOnly(req.auth);
  res.json(await supportService.grant(req.auth, req.body));
});
export const supportRevoke = asyncHandler(async (req, res) => {
  ownerOnly(req.auth);
  res.json(await supportService.revoke(req.auth));
});
