import asyncHandler from '../utils/asyncHandler.js';
import * as billingService from '../services/billingService.js';

// GET /api/billing/plans  (no login — used on the sign-up page)
export const plans = asyncHandler(async (req, res) => {
  res.json(billingService.listPlans());
});

// GET /api/billing/config  (public: is billing switched on, how long is the trial)
export const config = asyncHandler(async (req, res) => {
  res.json(billingService.getConfig());
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
// POST /api/billing/change  { plan, interval }  (smaller plan / monthly ↔ yearly, from the next period)
export const scheduleChange = asyncHandler(async (req, res) => {
  res.json(await billingService.scheduleChange(req.auth, req.body));
});

// DELETE /api/billing/change
export const cancelChange = asyncHandler(async (req, res) => {
  res.json(await billingService.cancelScheduledChange(req.auth));
});

// POST /api/billing/auto-renew  { on }
export const autoRenew = asyncHandler(async (req, res) => {
  res.json(await billingService.setAutoRenew(req.auth, req.body));
});

// GET /api/billing/card-link  (Paystack page to change the card)
export const cardLink = asyncHandler(async (req, res) => {
  res.json(await billingService.cardLink(req.auth));
});

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
