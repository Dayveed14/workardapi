// ============================================================
// Talks to Paystack using the BUSINESS'S OWN secret key.
// Money goes from the business's Paystack balance straight to staff —
// it never passes through Workard.
//
// Paystack docs: https://paystack.com/docs/transfers/
// Amounts are in kobo (Paystack's "subunit"), same as our database.
// ============================================================
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

async function request(secretKey, method, path, body) {
  let res;
  try {
    res = await fetch(`${env.paystackBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AppError(502, 'Could not reach Paystack. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw new AppError(res.status === 401 ? 422 : 502, `Paystack: ${data.message || 'request failed'}`);
  }
  return data.data;
}

// Nigerian banks with their Paystack codes (needed to pay into an account)
export async function listBanks(secretKey) {
  const banks = await request(secretKey, 'GET', '/bank?country=nigeria&currency=NGN&perPage=200');
  return banks.map((b) => ({ name: b.name, code: b.code }));
}

// Checks an account number and returns the account holder's name
export async function resolveAccount(secretKey, accountNumber, bankCode) {
  const data = await request(secretKey, 'GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
  return { accountName: data.account_name, accountNumber: data.account_number };
}

// A "recipient" is Paystack's saved copy of a bank account we can send money to
export async function createRecipient(secretKey, { name, accountNumber, bankCode }) {
  const data = await request(secretKey, 'POST', '/transferrecipient', {
    type: 'nuban',
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
  });
  return data.recipient_code;
}

// Up to 100 transfers per call. Each has OUR reference so a retry never pays twice.
// transfers: [{ amount (kobo), recipient (code), reference, reason }]
export async function bulkTransfer(secretKey, transfers) {
  return request(secretKey, 'POST', '/transfer/bulk', { currency: 'NGN', source: 'balance', transfers });
}

// Paystack signs every webhook with HMAC-SHA512 of the raw body using the secret key
export function isValidSignature(rawBody, signature, secretKey) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Accepting a payment (used for Workard's own subscription billing) ----------
// https://paystack.com/docs/payments/accept-payments/
// Starts a payment and returns the Paystack checkout page to send the customer to.
// planCode: also subscribe them to a Paystack plan, so the card is charged again automatically
export async function initializeTransaction(secretKey, { email, amountKobo, reference, callbackUrl, metadata, planCode }) {
  const data = await request(secretKey, 'POST', '/transaction/initialize', {
    email,
    amount: amountKobo,
    currency: 'NGN',
    reference,
    callback_url: callbackUrl,
    metadata,
    ...(planCode ? { plan: planCode } : {}),
  });
  return { authorizationUrl: data.authorization_url, reference: data.reference };
}

// Asks Paystack what happened to a payment. Never trust the browser's word for it.
export async function verifyTransaction(secretKey, reference) {
  const data = await request(secretKey, 'GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  return {
    status: data.status,
    amountKobo: Number(data.amount),
    currency: data.currency,
    paidAt: data.paid_at,
    customerId: data.customer?.id ?? null,
    customerCode: data.customer?.customer_code ?? null,
    authorizationCode: data.authorization?.reusable === false ? null : data.authorization?.authorization_code ?? null,
  };
}

// ---------- Subscriptions (automatic monthly / yearly charges) ----------
// https://paystack.com/docs/payments/subscriptions/

// A Paystack "plan" = a price + how often to charge it
export async function createPlan(secretKey, { name, interval, amountKobo }) {
  const data = await request(secretKey, 'POST', '/plan', {
    name,
    interval: interval === 'yearly' ? 'annually' : 'monthly',
    amount: amountKobo,
    currency: 'NGN',
  });
  return data.plan_code;
}

// Subscribe a customer whose card we already have. startDate = first automatic charge (ISO date-time).
export async function createSubscription(secretKey, { customerCode, planCode, authorizationCode, startDate }) {
  const data = await request(secretKey, 'POST', '/subscription', {
    customer: customerCode,
    plan: planCode,
    authorization: authorizationCode,
    start_date: startDate,
  });
  return { subscriptionCode: data.subscription_code, emailToken: data.email_token };
}

// Stop automatic charges (the current paid period still runs to its end)
export async function disableSubscription(secretKey, { code, token }) {
  await request(secretKey, 'POST', '/subscription/disable', { code, token });
}

// The customer's subscriptions (to find the one Paystack made after the first payment)
export async function listSubscriptions(secretKey, customerId) {
  const data = await request(secretKey, 'GET', `/subscription?customer=${encodeURIComponent(customerId)}`);
  return (data || []).map((s) => ({
    subscriptionCode: s.subscription_code,
    emailToken: s.email_token,
    status: s.status,
    planCode: s.plan?.plan_code,
  }));
}

// A Paystack page where the owner can change the card used for renewals
export async function manageLink(secretKey, code) {
  const data = await request(secretKey, 'GET', `/subscription/${encodeURIComponent(code)}/manage/link`);
  return data.link;
}
