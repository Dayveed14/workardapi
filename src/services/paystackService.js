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
