import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import * as c from '../controllers/siteController.js';
import { demoRequestSchema } from '../validators/adminSchemas.js';
import { blogListSchema } from '../validators/blogSchemas.js';

// /api/site — the Workard website itself, no login (prices, blog, demo requests)
const router = Router();
const demoLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many requests. Please try again later.' } });

router.get('/plans', c.plans);
router.post('/demo-requests', demoLimiter, validate(demoRequestSchema), c.demoRequest);
router.get('/blog', validate(blogListSchema, 'query'), c.blogList);
router.get('/blog/:slug', c.blogPost);
router.get('/build', c.build);

export default router;
