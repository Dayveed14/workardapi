import asyncHandler from '../utils/asyncHandler.js';
import * as announcementService from '../services/announcementService.js';

// GET /api/announcements?before=<id>   (the feed, 20 at a time)
export const feed = asyncHandler(async (req, res) => {
  res.json(await announcementService.listFeed(req.auth, req.validatedQuery));
});

// GET /api/announcements/groups   (who I can post to)
export const groups = asyncHandler(async (req, res) => {
  res.json(await announcementService.postingGroups(req.auth));
});

// GET /api/announcements/unseen   (dashboard card)
export const unseen = asyncHandler(async (req, res) => {
  res.json(await announcementService.latestUnseen(req.auth));
});

// POST /api/announcements   (multipart: fields + optional "file")
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await announcementService.createPost(req.auth, req.body, req.file));
});

// PATCH /api/announcements/:id   { title?, body?, isPinned? }
export const update = asyncHandler(async (req, res) => {
  res.json(await announcementService.updatePost(req.auth, req.params.id, req.body));
});

// DELETE /api/announcements/:id
export const remove = asyncHandler(async (req, res) => {
  await announcementService.deletePost(req.auth, req.params.id);
  res.status(204).end();
});

// POST /api/announcements/:id/comments   { body }
export const comment = asyncHandler(async (req, res) => {
  res.status(201).json(await announcementService.addComment(req.auth, req.params.id, req.body));
});

// DELETE /api/announcements/comments/:commentId
export const removeComment = asyncHandler(async (req, res) => {
  await announcementService.deleteComment(req.auth, req.params.commentId);
  res.status(204).end();
});

// POST /api/announcements/:id/acknowledge   ("I've read this")
export const acknowledge = asyncHandler(async (req, res) => {
  res.json(await announcementService.acknowledge(req.auth, req.params.id));
});

// GET /api/announcements/:id/readers   (who has seen it — author & group managers)
export const readers = asyncHandler(async (req, res) => {
  res.json(await announcementService.readers(req.auth, req.params.id));
});
