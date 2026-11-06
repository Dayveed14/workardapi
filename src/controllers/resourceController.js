import asyncHandler from '../utils/asyncHandler.js';
import * as resourceService from '../services/resourceService.js';

// GET /api/resources?search=
export const list = asyncHandler(async (req, res) => {
  res.json(await resourceService.list(req.auth, req.validatedQuery));
});

// GET /api/resources/groups  (who I can share with)
export const groups = asyncHandler(async (req, res) => {
  res.json(await resourceService.sharingGroups(req.auth));
});

// POST /api/resources  (document: JSON with body; file: multipart with "file")
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await resourceService.create(req.auth, req.body, req.file));
});

// GET /api/resources/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await resourceService.getOne(req.auth, req.params.id));
});

// PATCH /api/resources/:id  { title?, description?, body? (documents only) }
export const update = asyncHandler(async (req, res) => {
  res.json(await resourceService.update(req.auth, req.params.id, req.body));
});

// POST /api/resources/:id/file  (multipart "file": a new version of an uploaded file)
export const replaceFile = asyncHandler(async (req, res) => {
  res.json(await resourceService.replaceFile(req.auth, req.params.id, req.file));
});

// GET /api/resources/:id/versions/:version
export const version = asyncHandler(async (req, res) => {
  res.json(await resourceService.getVersion(req.auth, req.params.id, Number(req.params.version)));
});

// POST /api/resources/:id/send  { email, message }
export const send = asyncHandler(async (req, res) => {
  res.json(await resourceService.sendToGroup(req.auth, req.params.id, req.body));
});

// DELETE /api/resources/:id
export const remove = asyncHandler(async (req, res) => {
  await resourceService.remove(req.auth, req.params.id);
  res.status(204).end();
});
