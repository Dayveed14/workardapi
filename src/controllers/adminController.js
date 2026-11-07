import asyncHandler from '../utils/asyncHandler.js';
import * as adminAuthService from '../services/adminAuthService.js';
import * as adminService from '../services/adminService.js';
import * as platformSettingsService from '../services/platformSettingsService.js';
import * as supportService from '../services/supportService.js';
import * as blogService from '../services/blogService.js';
import { rebuildConfigured } from '../services/deployHookService.js';

// ============================================================
// /api/admin — the Workard super admin area (see adminRoutes.js)
// ============================================================

// ---------- Log-in ----------
export const login = asyncHandler(async (req, res) => res.json(await adminAuthService.login(req.body)));
export const verify = asyncHandler(async (req, res) => res.json(await adminAuthService.verify(res, req.body)));
export const resend = asyncHandler(async (req, res) => res.json(await adminAuthService.resend(req.body)));
export const logout = asyncHandler(async (req, res) => res.json(adminAuthService.logout(res)));
export const me = asyncHandler(async (req, res) => res.json(await adminAuthService.session(req.admin.userId)));
export const checkSetup = asyncHandler(async (req, res) => res.json(await adminAuthService.checkSetup(req.params.token)));
export const completeSetup = asyncHandler(async (req, res) => res.json(await adminAuthService.completeSetup(req.params.token, req.body.password)));

// ---------- Overview & companies ----------
export const overview = asyncHandler(async (req, res) => res.json(await adminService.overview()));
export const companies = asyncHandler(async (req, res) => res.json(await adminService.listCompanies(req.validatedQuery)));
export const company = asyncHandler(async (req, res) => res.json(await adminService.getCompany(req.params.id)));
export const extendTrial = asyncHandler(async (req, res) => res.json(await adminService.extendTrial(req.admin, req.params.id, req.body.days)));
export const setPlan = asyncHandler(async (req, res) => res.json(await adminService.setPlan(req.admin, req.params.id, req.body)));
export const setExempt = asyncHandler(async (req, res) => res.json(await adminService.setExempt(req.admin, req.params.id, req.body.exempt)));
export const suspend = asyncHandler(async (req, res) => res.json(await adminService.suspend(req.admin, req.params.id, req.body.reason)));
export const restore = asyncHandler(async (req, res) => res.json(await adminService.restore(req.admin, req.params.id)));
export const openSupport = asyncHandler(async (req, res) => res.json(await supportService.openSession(req.admin, res, req.params.id)));

// ---------- Users & payments ----------
export const users = asyncHandler(async (req, res) => res.json(await adminService.listUsers(req.validatedQuery)));
export const lockUser = asyncHandler(async (req, res) => res.json(await adminService.setUserLocked(req.admin, req.params.id, req.body.locked)));
export const resetUser = asyncHandler(async (req, res) => res.json(await adminService.sendPasswordReset(req.admin, req.params.id)));
export const payments = asyncHandler(async (req, res) => res.json(await adminService.listPayments(req.validatedQuery)));

// ---------- Prices & trial ----------
export const pricing = asyncHandler(async (req, res) => res.json({ ...platformSettingsService.currentPricing(), rebuildConfigured: rebuildConfigured() }));
export const savePricing = asyncHandler(async (req, res) => res.json(await platformSettingsService.savePricing(req.admin, req.body)));
export const resetPricing = asyncHandler(async (req, res) => res.json(await platformSettingsService.resetPricing(req.admin)));

// ---------- Announcements, demos, admins, log ----------
export const announcements = asyncHandler(async (req, res) => res.json(await adminService.listAnnouncements()));
export const sendAnnouncement = asyncHandler(async (req, res) => res.status(201).json(await adminService.sendAnnouncement(req.admin, req.body)));
export const demos = asyncHandler(async (req, res) => res.json(await adminService.listDemoRequests(req.validatedQuery)));
export const updateDemo = asyncHandler(async (req, res) => res.json(await adminService.updateDemoRequest(req.admin, req.params.id, req.body)));
export const admins = asyncHandler(async (req, res) => res.json(await adminService.listAdmins()));
export const addAdmin = asyncHandler(async (req, res) => res.status(201).json(await adminAuthService.addAdmin(req.admin, req.body)));
export const removeAdmin = asyncHandler(async (req, res) => {
  await adminAuthService.removeAdmin(req.admin, req.params.userId);
  res.status(204).end();
});
export const log = asyncHandler(async (req, res) => res.json(await adminService.listLog(req.validatedQuery)));

// ---------- Blog ----------
export const posts = asyncHandler(async (req, res) => res.json(await blogService.listPosts(req.validatedQuery)));
export const post = asyncHandler(async (req, res) => res.json(await blogService.getPost(req.params.id)));
export const createPost = asyncHandler(async (req, res) => res.status(201).json(await blogService.createPost(req.admin, req.body)));
export const updatePost = asyncHandler(async (req, res) => res.json(await blogService.updatePost(req.admin, req.params.id, req.body)));
export const deletePost = asyncHandler(async (req, res) => {
  await blogService.deletePost(req.admin, req.params.id);
  res.status(204).end();
});
export const uploadBlogImage = asyncHandler(async (req, res) => res.status(201).json(await blogService.uploadImage(req.admin, req.file)));
