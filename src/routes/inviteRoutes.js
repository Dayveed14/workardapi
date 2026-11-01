import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import * as inviteController from '../controllers/inviteController.js';
import { acceptInviteSchema } from '../validators/authSchemas.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

// Public — the person isn't logged in yet
router.get('/:token', limiter, inviteController.getInvite);
router.post('/:token/accept', limiter, validate(acceptInviteSchema), inviteController.acceptInvite);

export default router;
