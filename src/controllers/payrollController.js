import asyncHandler from '../utils/asyncHandler.js';
import * as payrollService from '../services/payrollService.js';
import * as payoutService from '../services/payoutService.js';
import * as employeePayService from '../services/employeePayService.js';

// ----- Runs -----
// GET /api/payroll  → runs, settings, employees missing a salary
export const list = asyncHandler(async (req, res) => {
  res.json(await payrollService.listRuns(req.auth.orgId));
});

// POST /api/payroll  { period: "2026-11" }
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await payrollService.createRun(req.auth, req.body));
});

// GET /api/payroll/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await payrollService.getRun(req.auth, req.params.id));
});

export const recalculate = asyncHandler(async (req, res) => {
  res.json(await payrollService.recalculate(req.auth, req.params.id));
});

// PATCH /api/payroll/items/:itemId  { bonus, oneOffDeduction }  (naira)
export const adjustItem = asyncHandler(async (req, res) => {
  res.json(await payrollService.adjustItem(req.auth, req.params.itemId, req.body));
});

export const approve = asyncHandler(async (req, res) => {
  res.json(await payrollService.approveRun(req.auth, req.params.id));
});

export const cancel = asyncHandler(async (req, res) => {
  res.json(await payrollService.cancelRun(req.auth, req.params.id));
});

// POST /api/payroll/:id/mark-paid  { paidOn, method }
export const markPaid = asyncHandler(async (req, res) => {
  res.json(await payrollService.markPaid(req.auth, req.params.id, req.body));
});

// POST /api/payroll/:id/pay-paystack
export const payWithPaystack = asyncHandler(async (req, res) => {
  await payoutService.payWithPaystack(req.auth, req.params.id);
  res.json(await payrollService.getRun(req.auth, req.params.id));
});

export const bankSchedule = asyncHandler(async (req, res) => {
  res.json(await payrollService.bankSchedule(req.auth, req.params.id));
});

export const remittances = asyncHandler(async (req, res) => {
  res.json(await payrollService.remittances(req.auth, req.params.id));
});

// ----- Settings & Paystack -----
export const getSettings = asyncHandler(async (req, res) => {
  res.json(await payrollService.getSettings(req.auth.orgId));
});

export const updateSettings = asyncHandler(async (req, res) => {
  res.json(await payrollService.updateSettings(req.auth, req.body));
});

export const connectPaystack = asyncHandler(async (req, res) => {
  res.json(await payrollService.connectPaystack(req.auth, req.body));
});

export const disconnectPaystack = asyncHandler(async (req, res) => {
  res.json(await payrollService.disconnectPaystack(req.auth));
});

export const banks = asyncHandler(async (req, res) => {
  res.json(await payoutService.listBanks(req.auth.orgId));
});

export const verifyAccount = asyncHandler(async (req, res) => {
  res.json(await payoutService.verifyAccount(req.auth.orgId, req.body));
});

// ----- Employee pay (Pay tab) -----
// GET /api/employees/:id/pay
export const getEmployeePay = asyncHandler(async (req, res) => {
  res.json(await employeePayService.getPay(req.auth, req.params.id));
});

// PUT /api/employees/:id/pay
export const saveEmployeePay = asyncHandler(async (req, res) => {
  res.json(await employeePayService.savePay(req.auth, req.params.id, req.body));
});

// ----- Payslips -----
// GET /api/me/payslips
export const myPayslips = asyncHandler(async (req, res) => {
  res.json(await payrollService.myPayslips(req.auth));
});

// GET /api/payroll/payslips/:itemId  (your own, or anyone's with payroll.view)
export const payslip = asyncHandler(async (req, res) => {
  res.json(await payrollService.getPayslip(req.auth, req.params.itemId));
});

// ----- Paystack webhook (no login; checked by signature) -----
export const paystackWebhook = async (req, res) => {
  try {
    await payoutService.handleWebhook(req.params.orgId, req.body, req.get('x-paystack-signature'));
    res.sendStatus(200);
  } catch (err) {
    if (err.status === 401) return res.sendStatus(401);
    console.error('Paystack webhook error:', err);
    res.sendStatus(500); // Paystack will retry
  }
};
