import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as invoiceController from '../controllers/invoiceController.js';

// Pages anyone with the link can open (no login) — e.g. a customer viewing their invoice.
// The token is 32 random characters, so links can't be guessed.
const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

router.get('/invoices/:token', limiter, invoiceController.getPublic);

export default router;
