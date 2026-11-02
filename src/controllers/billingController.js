import asyncHandler from '../utils/asyncHandler.js';
import * as billingService from '../services/billingService.js';

// GET /api/billing/plans  (no login — used on the sign-up page)
export const plans = asyncHandler(async (req, res) => {
  res.json(billingService.listPlans());
});

// GET /api/billing  (current plan, prices, what an upgrade would cost, payment history)
export const overview = asyncHandler(async (req, res) => {
  res.json(await billingService.getBilling(req.auth));
});

// POST /api/billing/checkout  { plan } → { authorizationUrl } (send the owner to Paystack)
export const checkout = asyncHandler(async (req, res) => {
  res.status(201).json(await billingService.checkout(req.auth, req.body));
});

// POST /api/billing/verify  { reference } (the page Paystack sends the owner back to)
export const verify = asyncHandler(async (req, res) => {
  res.json(await billingService.verifyPayment(req.body.reference, req.auth.orgId));
});

// POST /api/webhooks/paystack-billing  (Paystack → Workard; raw body, signed)
export const webhook = async (req, res) => {
  try {
    await billingService.handleWebhook(req.body, req.get('x-paystack-signature'));
    res.sendStatus(200);
  } catch (err) {
    if (err.status === 401) return res.sendStatus(401);
    console.error('Billing webhook failed:', err.message);
    res.sendStatus(500); // Paystack will retry
  }
};
