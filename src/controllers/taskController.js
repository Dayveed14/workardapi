import asyncHandler from '../utils/asyncHandler.js';
import * as taskService from '../services/taskService.js';

// GET /api/tasks?view=mine|created|team&status=&due=&assigneeId=&customerId=&search=&page=
export const list = asyncHandler(async (req, res) => {
  res.json(await taskService.listTasks(req.auth, req.validatedQuery));
});

// GET /api/tasks/counts
export const counts = asyncHandler(async (req, res) => {
  res.json(await taskService.getCounts(req.auth));
});

// GET /api/tasks/assignees  (who I can give tasks to)
export const assignees = asyncHandler(async (req, res) => {
  res.json(await taskService.listAssignees(req.auth));
});

// POST /api/tasks
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await taskService.createTask(req.auth, req.body));
});

// GET /api/tasks/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await taskService.getTask(req.auth, req.params.id));
});

// PATCH /api/tasks/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await taskService.updateTask(req.auth, req.params.id, req.body));
});

// PATCH /api/tasks/:id/status
export const setStatus = asyncHandler(async (req, res) => {
  res.json(await taskService.setStatus(req.auth, req.params.id, req.body.status));
});

// DELETE /api/tasks/:id
export const remove = asyncHandler(async (req, res) => {
  await taskService.deleteTask(req.auth, req.params.id);
  res.json({ message: 'Task deleted' });
});

// POST /api/tasks/:id/checklist
export const addChecklistItem = asyncHandler(async (req, res) => {
  res.status(201).json(await taskService.addChecklistItem(req.auth, req.params.id, req.body.text));
});

// PATCH /api/tasks/checklist/:itemId
export const toggleChecklistItem = asyncHandler(async (req, res) => {
  res.json(await taskService.toggleChecklistItem(req.auth, req.params.itemId, req.body.isDone));
});

// DELETE /api/tasks/checklist/:itemId
export const removeChecklistItem = asyncHandler(async (req, res) => {
  res.json(await taskService.removeChecklistItem(req.auth, req.params.itemId));
});

// POST /api/tasks/:id/comments
export const addComment = asyncHandler(async (req, res) => {
  res.status(201).json(await taskService.addComment(req.auth, req.params.id, req.body.body));
});

// POST /api/tasks/:id/attachments  (multipart, field "file")
export const addAttachment = asyncHandler(async (req, res) => {
  res.status(201).json(await taskService.addAttachment(req.auth, req.params.id, req.file));
});

// DELETE /api/tasks/attachments/:attachmentId
export const removeAttachment = asyncHandler(async (req, res) => {
  res.json(await taskService.removeAttachment(req.auth, req.params.attachmentId));
});

// ---------- Repeating tasks ----------
export const listRecurring = asyncHandler(async (req, res) => {
  res.json(await taskService.listRecurring(req.auth));
});

export const createRecurring = asyncHandler(async (req, res) => {
  res.status(201).json(await taskService.createRecurring(req.auth, req.body));
});

export const updateRecurring = asyncHandler(async (req, res) => {
  res.json(await taskService.updateRecurring(req.auth, req.params.id, req.body));
});

export const removeRecurring = asyncHandler(async (req, res) => {
  await taskService.deleteRecurring(req.auth, req.params.id);
  res.json({ message: 'Repeating task deleted' });
});
