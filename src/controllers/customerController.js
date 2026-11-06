import asyncHandler from '../utils/asyncHandler.js';
import * as customerService from '../services/customerService.js';
import * as salesService from '../services/salesService.js';

// GET /api/customers?search=&stage=&assignedEmployeeId=&page=
export const list = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomers(req.auth, req.scope, req.validatedQuery));
});

// GET /api/customers/options  (dropdown on the invoice form)
export const options = asyncHandler(async (req, res) => {
  res.json(await customerService.listOptions(req.auth.orgId));
});

// GET /api/customers/follow-ups
export const followUps = asyncHandler(async (req, res) => {
  res.json(await customerService.listFollowUps(req.auth, req.scope));
});

// GET /api/customers/cases  (open enquiries & complaints)
export const openCases = asyncHandler(async (req, res) => {
  res.json(await customerService.listOpenCases(req.auth, req.scope));
});

// GET /api/customers/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await customerService.getCustomer(req.auth, req.params.id));
});

// POST /api/customers
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await customerService.createCustomer(req.auth, req.body));
});

// PATCH /api/customers/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await customerService.updateCustomer(req.auth, req.params.id, req.body));
});

// GET /api/customers/:id/activity
export const activity = asyncHandler(async (req, res) => {
  res.json(await customerService.listActivity(req.auth, req.params.id));
});

// POST /api/customers/:id/activity
export const addActivity = asyncHandler(async (req, res) => {
  res.status(201).json(await customerService.addActivity(req.auth, req.params.id, req.body));
});

// PATCH /api/customers/activity/:interactionId/resolve
export const resolveCase = asyncHandler(async (req, res) => {
  res.json(await customerService.resolveCase(req.auth, req.params.interactionId));
});

// PATCH /api/customers/activity/:interactionId/follow-up-done
export const completeFollowUp = asyncHandler(async (req, res) => {
  res.json(await customerService.completeFollowUp(req.auth, req.params.interactionId));
});

// GET /api/customers/:id/payments
export const payments = asyncHandler(async (req, res) => {
  res.json(await customerService.listPayments(req.auth, req.params.id));
});

// GET /api/customers/sales?months=6  (sales dashboard for the customers in scope)
export const sales = asyncHandler(async (req, res) => {
  res.json(await salesService.getSales(req.auth, req.scope, req.validatedQuery.months));
});

// GET /api/customers/:id/stages  (how this customer moved through the pipeline)
export const stages = asyncHandler(async (req, res) => {
  await customerService.getCustomer(req.auth, req.params.id); // checks scope
  res.json(await salesService.stageHistory(req.params.id));
});

// GET /api/customers/assigned-to-me  (dashboard card)
export const assignedToMe = asyncHandler(async (req, res) => {
  res.json(await customerService.assignedToMe(req.auth));
});
