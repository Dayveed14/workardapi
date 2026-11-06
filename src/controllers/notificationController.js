import asyncHandler from '../utils/asyncHandler.js';
import * as notificationService from '../services/notificationService.js';

// GET /api/notifications  (latest 30 + unread count)
export const list = asyncHandler(async (req, res) => {
  res.json(await notificationService.listMine(req.auth));
});

// GET /api/notifications/count  (cheap — the bell asks every ~30 seconds)
export const count = asyncHandler(async (req, res) => {
  res.json(await notificationService.countMine(req.auth));
});

// PATCH /api/notifications/:id/read
export const markRead = asyncHandler(async (req, res) => {
  await notificationService.markRead(req.auth, req.params.id);
  res.json(await notificationService.countMine(req.auth));
});

// POST /api/notifications/read-all
export const markAllRead = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.auth);
  res.json({ unread: 0 });
});
