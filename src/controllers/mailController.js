import asyncHandler from '../utils/asyncHandler.js';
import * as mailAccountService from '../services/mailAccountService.js';
import * as mailService from '../services/mailService.js';

// ---------- My mailbox ----------
// GET /api/mail/account
export const status = asyncHandler(async (req, res) => res.json(await mailAccountService.getStatus(req.auth)));

// POST /api/mail/connect/:provider  → { url } (the browser goes there to sign in)
export const connect = asyncHandler(async (req, res) => {
  res.json(await mailAccountService.startConnect(req.auth, req.params.provider, req.body));
});

// GET /api/mail/oauth/:provider/callback  (Google/Microsoft send the browser here — no log-in cookie needed)
export const callback = asyncHandler(async (req, res) => {
  res.redirect(await mailAccountService.handleCallback(req.params.provider, req.query));
});

// DELETE /api/mail/account
export const disconnect = asyncHandler(async (req, res) => res.json(await mailAccountService.disconnect(req.auth)));

// PUT /api/mail/account/signature
export const signature = asyncHandler(async (req, res) => res.json(await mailAccountService.setSignature(req.auth, req.body)));

// ---------- Sending & the record ----------
// GET /api/mail/contacts?search=
export const contacts = asyncHandler(async (req, res) => res.json(await mailService.contacts(req.auth, req.validatedQuery)));

// POST /api/mail/send  (multipart: "data" = JSON, "files" = attachments)
export const send = asyncHandler(async (req, res) => res.status(201).json(await mailService.send(req.auth, req.body, req.files)));

// POST /api/mail/links  (one big file → a link to put in the email)
export const uploadLink = asyncHandler(async (req, res) => res.status(201).json(await mailService.uploadLink(req.auth, req.file)));

// GET /api/mail/sent?box=&customerId=&employeeId=&invoiceId=&search=&page=
export const listSent = asyncHandler(async (req, res) => res.json(await mailService.listSent(req.auth, req.validatedQuery)));

// GET /api/mail/sent/:id
export const getSent = asyncHandler(async (req, res) => res.json(await mailService.getSent(req.auth, req.params.id)));

// ---------- Templates ----------
export const listTemplates = asyncHandler(async (req, res) => res.json(await mailService.listTemplates(req.auth)));
export const createTemplate = asyncHandler(async (req, res) => res.status(201).json(await mailService.createTemplate(req.auth, req.body)));
export const updateTemplate = asyncHandler(async (req, res) => res.json(await mailService.updateTemplate(req.auth, req.params.id, req.body)));
export const deleteTemplate = asyncHandler(async (req, res) => {
  await mailService.deleteTemplate(req.auth, req.params.id);
  res.status(204).end();
});
// POST /api/mail/templates/:id/fill { customerId?, invoiceId?, employeeId? } → { subject, html }
export const fillTemplate = asyncHandler(async (req, res) => res.json(await mailService.fillTemplate(req.auth, req.params.id, req.body)));

// ---------- Inbox (live from Google / Microsoft) ----------
export const inbox = asyncHandler(async (req, res) => res.json(await mailService.listInbox(req.auth, req.validatedQuery)));
export const thread = asyncHandler(async (req, res) => res.json(await mailService.getThread(req.auth, req.params.threadId)));
export const markRead = asyncHandler(async (req, res) => res.json(await mailService.markRead(req.auth, req.params.threadId)));

// GET /api/mail/inbox/messages/:messageId/attachments/:attachmentId?name=&type=  → the file
export const attachment = asyncHandler(async (req, res) => {
  const { content } = await mailService.getAttachment(req.auth, req.params.messageId, req.params.attachmentId);
  const name = String(req.query.name || 'attachment').replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', 'application/octet-stream'); // always download, never render
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(content);
});

// POST /api/mail/inbox/threads/:threadId/messages/:messageId/reply  (multipart like send)
export const reply = asyncHandler(async (req, res) => {
  res.status(201).json(await mailService.reply(req.auth, req.params.threadId, req.params.messageId, req.body, req.files));
});
