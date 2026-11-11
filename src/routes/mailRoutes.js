import { Router } from 'express';
import { requireAuth, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadMailFiles, uploadMailLink } from '../middleware/upload.js';
import * as mailController from '../controllers/mailController.js';
import {
  sendSchema,
  replySchema,
  connectSchema,
  signatureSchema,
  templateSchema,
  fillSchema,
  listSchema,
  inboxSchema,
  contactsSchema,
} from '../validators/mailSchemas.js';
import AppError from '../utils/AppError.js';

// /api/mail — email from your own Gmail / Outlook (Business plan and up).
// No permissions: everyone connects their OWN mailbox; who can see a sent email is decided
// in sentEmailModel (sender + Workard users it went to).
const router = Router();

// Google / Microsoft send the browser back here after sign-in. It has no Workard log-in check:
// the one-time "state" in the address identifies who is connecting (see mailAccountService).
router.get('/oauth/:provider/callback', mailController.callback);

router.use(requireAuth, requireFeature('mail'));

// Sending with files is multipart: the message itself arrives as a JSON string in "data"
function jsonField(req, res, next) {
  try {
    if (typeof req.body?.data === 'string') req.body = JSON.parse(req.body.data);
    next();
  } catch {
    next(new AppError(422, 'The message could not be read'));
  }
}

// My mailbox
router.get('/account', mailController.status);
router.delete('/account', mailController.disconnect);
router.put('/account/signature', validate(signatureSchema), mailController.signature);
router.post('/connect/:provider', validate(connectSchema), mailController.connect);

// Sending & the record
router.get('/contacts', validate(contactsSchema, 'query'), mailController.contacts);
router.post('/send', uploadMailFiles, jsonField, validate(sendSchema), mailController.send);
router.post('/links', uploadMailLink, mailController.uploadLink);
router.get('/sent', validate(listSchema, 'query'), mailController.listSent);
router.get('/sent/:id', mailController.getSent);

// Templates
router.get('/templates', mailController.listTemplates);
router.post('/templates', validate(templateSchema), mailController.createTemplate);
router.put('/templates/:id', validate(templateSchema), mailController.updateTemplate);
router.delete('/templates/:id', mailController.deleteTemplate);
router.post('/templates/:id/fill', validate(fillSchema), mailController.fillTemplate);

// Inbox (live)
router.get('/inbox', validate(inboxSchema, 'query'), mailController.inbox);
router.get('/inbox/threads/:threadId', mailController.thread);
router.post('/inbox/threads/:threadId/read', mailController.markRead);
router.get('/inbox/messages/:messageId/attachments/:attachmentId', mailController.attachment);
router.post('/inbox/threads/:threadId/messages/:messageId/reply', uploadMailFiles, jsonField, validate(replySchema), mailController.reply);

export default router;
