import asyncHandler from '../utils/asyncHandler.js';
import * as documentService from '../services/documentService.js';

// GET /api/employees/:id/documents
export const list = asyncHandler(async (req, res) => {
  res.json(await documentService.listDocuments(req.auth, req.params.id));
});

// POST /api/employees/:id/documents (multipart: file, title, category)
export const upload = asyncHandler(async (req, res) => {
  res.status(201).json(await documentService.uploadDocument(req.auth, req.params.id, req.file, req.body));
});

// DELETE /api/documents/:documentId
export const remove = asyncHandler(async (req, res) => {
  await documentService.deleteDocument(req.auth, req.params.documentId);
  res.json({ message: 'Document deleted' });
});
