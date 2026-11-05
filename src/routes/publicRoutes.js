import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as invoiceController from '../controllers/invoiceController.js';
import { validate } from '../middleware/validate.js';
import { acceptInvoiceSchema } from '../validators/invoiceSchemas.js';

// Pages anyone with the link can open (no login) — e.g. a customer viewing their invoice.
// The token is 32 random characters, so links can't be guessed.
const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

router.get('/invoices/:token', limiter, invoiceController.getPublic);
// The customer accepts & signs (stricter limit: 10 tries per 15 minutes)
const acceptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
router.post('/invoices/:token/accept', acceptLimiter, validate(acceptInvoiceSchema), invoiceController.acceptPublic);

export default router;
