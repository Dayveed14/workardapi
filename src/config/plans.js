// ============================================================
// PLANS — what each subscription includes, paid monthly or yearly.
// Change prices, features or limits HERE only; the API and the
// pricing on the home page both read from this list (the client
// keeps a copy in src/config/plans.js — keep them in step).
//
// Features (each one switches on part of the app):
//   hr        employees, attendance & clock-in, leave, documents, onboarding
//   tasks     tasks & repeating tasks
//   reviews   performance reviews
//   payroll   salaries, PAYE, pension, payslips
//   crm       customers, follow-ups, enquiries & complaints
//   invoices  invoices & payments
//   finance   income, expenses & profit report
//   calls     cloud business phone (coming soon)
//
// Limits: null = no limit.
// ============================================================

import { env } from './env.js';

// The billing switch (from .env). Kept as a plain object so the tests can flip it.
export const billing = {
  enabled: env.billingEnabled,
  trialDays: env.trialDays,
  startDate: env.billingStartDate || null,
};

export const PLAN_ORDER = ['starter', 'business', 'enterprise'];

// How often an organisation can pay. Paystack charges the saved card again automatically.
export const INTERVALS = ['monthly', 'yearly'];

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    // ₦15,000 a month, or ₦12,999 a month paid yearly (₦155,988)
    prices: { monthly: 1_500_000, yearly: 15_598_800 },
    features: ['hr'],
    maxEmployees: 10,
    maxBranches: 1,
    customRoles: false,
  },
  business: {
    id: 'business',
    name: 'Business',
    // ₦35,000 a month, or ₦32,999 a month paid yearly (₦395,988)
    prices: { monthly: 3_500_000, yearly: 39_598_800 },
    features: ['hr', 'tasks', 'reviews', 'payroll', 'crm', 'invoices', 'finance'],
    maxEmployees: null,
    maxBranches: 3,
    customRoles: false,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    // ₦55,000 a month, or ₦53,999 a month paid yearly (₦647,988)
    prices: { monthly: 5_500_000, yearly: 64_798_800 },
    features: ['hr', 'tasks', 'reviews', 'payroll', 'crm', 'invoices', 'finance', 'calls'],
    maxEmployees: null,
    maxBranches: null,
    customRoles: true,
  },
};

// Days the app keeps working after a period ends without payment (e.g. the card was declined)
export const GRACE_DAYS = 7;

export const FEATURE_NAMES = {
  hr: 'Employees & HR',
  tasks: 'Tasks',
  reviews: 'Performance reviews',
  payroll: 'Payroll',
  crm: 'Customers (CRM)',
  invoices: 'Invoicing',
  finance: 'Finance',
  calls: 'Cloud phone',
};
