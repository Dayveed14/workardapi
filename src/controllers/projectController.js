import asyncHandler from '../utils/asyncHandler.js';
import * as projectService from '../services/projectService.js';

// GET /api/projects?status=
export const list = asyncHandler(async (req, res) => {
  res.json(await projectService.list(req.auth, req.validatedQuery));
});

// GET /api/projects/groups  (who I can create projects for)
export const groups = asyncHandler(async (req, res) => {
  res.json(await projectService.projectGroups(req.auth));
});

// POST /api/projects
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await projectService.createProject(req.auth, req.body));
});

// GET /api/projects/:id  (project + tasks + people with their progress)
export const getOne = asyncHandler(async (req, res) => {
  res.json(await projectService.getProject(req.auth, req.params.id));
});

// PATCH /api/projects/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await projectService.updateProject(req.auth, req.params.id, req.body));
});

// DELETE /api/projects/:id  (its tasks are kept)
export const remove = asyncHandler(async (req, res) => {
  await projectService.deleteProject(req.auth, req.params.id);
  res.status(204).end();
});
