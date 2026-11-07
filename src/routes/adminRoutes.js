import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { uploadImage } from '../middleware/upload.js';
import * as c from '../controllers/adminController.js';
import * as s from '../validators/adminSchemas.js';
import { blogPostSchema, blogPostUpdateSchema } from '../validators/blogSchemas.js';

// ============================================================
// /api/admin — Workard super admins only (separate log-in, cookie wk_admin)
// ============================================================
const router = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many attempts. Please try again in a few minutes.' } });

// Log-in (no session yet)
router.post('/auth/login', limiter, validate(s.adminLoginSchema), c.login);
router.post('/auth/verify', limiter, validate(s.adminVerifySchema), c.verify);
router.post('/auth/resend', limiter, validate(s.adminResendSchema), c.resend);
router.post('/auth/logout', c.logout);
router.get('/auth/setup/:token', limiter, c.checkSetup);
router.post('/auth/setup/:token', limiter, validate(s.adminSetupSchema), c.completeSetup);

router.use(requireAdmin);
router.get('/auth/me', c.me);

router.get('/overview', c.overview);

router.get('/companies', validate(s.companiesQuerySchema, 'query'), c.companies);
router.get('/companies/:id', c.company);
router.post('/companies/:id/extend-trial', validate(s.extendTrialSchema), c.extendTrial);
router.post('/companies/:id/plan', validate(s.setPlanSchema), c.setPlan);
router.post('/companies/:id/exempt', validate(s.exemptSchema), c.setExempt);
router.post('/companies/:id/suspend', validate(s.suspendSchema), c.suspend);
router.post('/companies/:id/restore', c.restore);
router.post('/companies/:id/support', c.openSupport); // only while the owner allows it

router.get('/users', validate(s.searchSchema, 'query'), c.users);
router.post('/users/:id/lock', validate(s.lockSchema), c.lockUser);
router.post('/users/:id/reset', c.resetUser);

router.get('/payments', validate(s.pageSchema, 'query'), c.payments);

router.get('/pricing', c.pricing);
router.put('/pricing', validate(s.pricingSchema), c.savePricing);
router.delete('/pricing', c.resetPricing);

router.get('/announcements', c.announcements);
router.post('/announcements', validate(s.platformAnnouncementSchema), c.sendAnnouncement);

router.get('/demos', validate(s.pageSchema, 'query'), c.demos);
router.patch('/demos/:id', validate(s.demoUpdateSchema), c.updateDemo);

router.get('/admins', c.admins);
router.post('/admins', validate(s.addAdminSchema), c.addAdmin);
router.delete('/admins/:userId', c.removeAdmin);

router.get('/log', validate(s.pageSchema, 'query'), c.log);

router.get('/blog', validate(s.searchSchema, 'query'), c.posts);
router.post('/blog/images', uploadImage, c.uploadBlogImage);
router.post('/blog', validate(blogPostSchema), c.createPost);
router.get('/blog/:id', c.post);
router.patch('/blog/:id', validate(blogPostUpdateSchema), c.updatePost);
router.delete('/blog/:id', c.deletePost);

export default router;
