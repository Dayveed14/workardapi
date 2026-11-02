// ============================================================
// PLANS — what each yearly subscription includes.
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

export const PLAN_ORDER = ['starter', 'business', 'enterprise'];

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceKobo: 25_000_000, // ₦250,000 a year
    features: ['hr'],
    maxEmployees: 10,
    maxBranches: 1,
    customRoles: false,
  },
  business: {
    id: 'business',
    name: 'Business',
    priceKobo: 60_000_000, // ₦600,000 a year
    features: ['hr', 'tasks', 'reviews', 'payroll', 'crm', 'invoices', 'finance'],
    maxEmployees: null,
    maxBranches: 3,
    customRoles: false,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceKobo: 100_000_000, // ₦1,000,000 a year
    features: ['hr', 'tasks', 'reviews', 'payroll', 'crm', 'invoices', 'finance', 'calls'],
    maxEmployees: null,
    maxBranches: null,
    customRoles: true,
  },
};

// Days the app keeps working after the year ends, while the owner renews
export const GRACE_DAYS = 7;

// Renewing early is allowed in the last RENEW_WINDOW_DAYS of the year
export const RENEW_WINDOW_DAYS = 60;

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
