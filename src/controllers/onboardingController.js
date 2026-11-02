import asyncHandler from '../utils/asyncHandler.js';
import * as onboardingService from '../services/onboardingService.js';

// ---------- Checklists ----------
export const listTemplates = asyncHandler(async (req, res) => {
  res.json(await onboardingService.listTemplates(req.auth));
});
export const getTemplate = asyncHandler(async (req, res) => {
  res.json(await onboardingService.getTemplate(req.auth, req.params.id));
});
export const createTemplate = asyncHandler(async (req, res) => {
  res.status(201).json(await onboardingService.createTemplate(req.auth, req.body));
});
export const updateTemplate = asyncHandler(async (req, res) => {
  res.json(await onboardingService.updateTemplate(req.auth, req.params.id, req.body));
});
export const deleteTemplate = asyncHandler(async (req, res) => {
  await onboardingService.deleteTemplate(req.auth, req.params.id);
  res.json({ message: 'Checklist deleted' });
});

// ---------- Onboardings ----------
// GET /api/onboarding?status=
export const list = asyncHandler(async (req, res) => {
  res.json(await onboardingService.listOnboardings(req.auth, req.validatedQuery));
});
// GET /api/onboarding/mine
export const mine = asyncHandler(async (req, res) => {
  res.json(await onboardingService.getMine(req.auth));
});
// GET /api/onboarding/candidates  (employees not being onboarded)
export const candidates = asyncHandler(async (req, res) => {
  res.json(await onboardingService.listCandidates(req.auth));
});
// POST /api/onboarding  { employeeId, templateId, startDate }
export const start = asyncHandler(async (req, res) => {
  res.status(201).json(await onboardingService.startOnboarding(req.auth, req.body));
});
export const getOne = asyncHandler(async (req, res) => {
  res.json(await onboardingService.getOnboarding(req.auth, req.params.id));
});
// PATCH /api/onboarding/items/:itemId  { done }
export const setItemDone = asyncHandler(async (req, res) => {
  res.json(await onboardingService.setItemDone(req.auth, req.params.itemId, req.body.done));
});
export const addItem = asyncHandler(async (req, res) => {
  res.status(201).json(await onboardingService.addItem(req.auth, req.params.id, req.body));
});
export const removeItem = asyncHandler(async (req, res) => {
  res.json(await onboardingService.removeItem(req.auth, req.params.itemId));
});
export const cancel = asyncHandler(async (req, res) => {
  res.json(await onboardingService.cancelOnboarding(req.auth, req.params.id));
});
