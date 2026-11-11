import asyncHandler from '../utils/asyncHandler.js';
import * as offboardingService from '../services/offboardingService.js';

// /api/offboarding — someone leaving (see offboardingService for the rules)
export const settings = asyncHandler(async (req, res) => res.json(await offboardingService.getSettings(req.auth)));
export const setNotice = asyncHandler(async (req, res) => res.json(await offboardingService.setNoticeDays(req.auth, req.body.noticeDays)));
export const mine = asyncHandler(async (req, res) => res.json(await offboardingService.mine(req.auth)));
export const resign = asyncHandler(async (req, res) => res.status(201).json(await offboardingService.resign(req.auth, req.body)));
export const list = asyncHandler(async (req, res) => res.json(await offboardingService.list(req.auth, req.validatedQuery)));
export const start = asyncHandler(async (req, res) => res.status(201).json(await offboardingService.startByHr(req.auth, req.body)));
export const getOne = asyncHandler(async (req, res) => res.json(await offboardingService.get(req.auth, req.params.id)));
export const sendChecklist = asyncHandler(async (req, res) => res.json(await offboardingService.sendChecklist(req.auth, req.params.id, req.body.templateId)));
export const setItemDone = asyncHandler(async (req, res) => res.json(await offboardingService.setItemDone(req.auth, req.params.itemId, req.body)));
export const addItem = asyncHandler(async (req, res) => res.json(await offboardingService.addItem(req.auth, req.params.id, req.body)));
export const removeItem = asyncHandler(async (req, res) => res.json(await offboardingService.removeItem(req.auth, req.params.itemId)));
export const setLastDay = asyncHandler(async (req, res) => res.json(await offboardingService.setLastDay(req.auth, req.params.id, req.body.lastDay)));
export const exitNow = asyncHandler(async (req, res) => res.json(await offboardingService.exitNow(req.auth, req.params.id)));
export const withdraw = asyncHandler(async (req, res) => res.json(await offboardingService.withdraw(req.auth, req.params.id)));
export const cancel = asyncHandler(async (req, res) => res.json(await offboardingService.cancel(req.auth, req.params.id)));
