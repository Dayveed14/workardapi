// ============================================================
// PERMISSIONS
// A role is a list of permission keys. Each key has a SCOPE that
// decides WHOSE records the person can see or act on:
//
//   own        → only their own records (for customers: accounts assigned to them)
//   team       → people in teams they supervise (+ themselves)
//   department → people in their department
//   branch     → people in their branch
//   all        → everyone in the organisation
//
// Keys marked scoped: false only use "all".
// Things every employee can always do for THEMSELVES (clock in,
// request leave, see own profile) do not need a permission —
// they live under /api/me.
//
// Adding a new module? Add its keys here and to DEFAULT_ROLES,
// then run `npm run db:sync` so existing organisations get them.
// ============================================================

export const SCOPES = ['own', 'team', 'department', 'branch', 'all'];

export const PERMISSIONS = [
  { key: 'dashboard.view', module: 'Dashboard', label: 'View business dashboard', scoped: true },

  { key: 'employees.view', module: 'Employees', label: 'View employees', scoped: true },
  { key: 'employees.create', module: 'Employees', label: 'Add employees & send invites', scoped: false },
  { key: 'employees.edit', module: 'Employees', label: 'Edit employee details', scoped: true },
  { key: 'employees.exit', module: 'Employees', label: 'Exit (deactivate) employees', scoped: true },

  { key: 'documents.view', module: 'Documents', label: 'View employee documents', scoped: true },
  { key: 'documents.manage', module: 'Documents', label: 'Upload & delete employee documents', scoped: true },

  { key: 'attendance.view', module: 'Attendance', label: 'View attendance register', scoped: true },
  { key: 'attendance.review', module: 'Attendance', label: 'Approve or reject flagged clock-ins', scoped: true },

  { key: 'leave.view', module: 'Leave', label: 'View leave requests', scoped: true },
  { key: 'leave.approve', module: 'Leave', label: 'Approve or reject leave', scoped: true },

  // Phase 2 — scope is based on who the customer account is ASSIGNED to
  { key: 'customers.view', module: 'Customers (CRM)', label: 'View customers & their activity', scoped: true },
  { key: 'customers.manage', module: 'Customers (CRM)', label: 'Add & edit customers, log activity, assign accounts', scoped: true },

  { key: 'invoices.view', module: 'Invoices', label: 'View invoices & payments', scoped: false },
  { key: 'invoices.manage', module: 'Invoices', label: 'Create, edit, send & void invoices', scoped: false },
  { key: 'invoices.payments', module: 'Invoices', label: 'Record & remove invoice payments', scoped: false },

  { key: 'finance.view', module: 'Finance', label: 'View financial reports, income & expenses', scoped: false },
  { key: 'finance.manage', module: 'Finance', label: 'Record income & expenses, finance & invoice settings', scoped: false },

  // Phase 3 — salaries are sensitive, so these are never "scoped": you see all payroll or none
  { key: 'payroll.view', module: 'Payroll', label: 'View salaries, payroll runs & payslips', scoped: false },
  { key: 'payroll.manage', module: 'Payroll', label: 'Set salaries, prepare payroll & payroll settings', scoped: false },
  { key: 'payroll.approve', module: 'Payroll', label: 'Approve & pay payroll (not one you prepared)', scoped: false },

  // Tasks & reviews — scope is based on the person the task/review is FOR.
  // Direct managers ("Reports to") can always assign tasks to and review their own reports.
  { key: 'tasks.view', module: 'Tasks', label: 'See other people\'s tasks', scoped: true },
  { key: 'tasks.assign', module: 'Tasks', label: 'Assign & edit tasks for other people', scoped: true },
  { key: 'reviews.view', module: 'Reviews', label: 'See performance reviews', scoped: true },
  { key: 'reviews.manage', module: 'Reviews', label: 'Start & write performance reviews', scoped: true },
  { key: 'reviews.setup', module: 'Reviews', label: 'Set review criteria & how often reviews happen', scoped: false },

  // Onboarding — checklists for new joiners (every plan)
  { key: 'onboarding.manage', module: 'Onboarding', label: 'Set up onboarding checklists & onboard new joiners', scoped: false },

  { key: 'organization.manage', module: 'Settings', label: 'Manage branches, departments, teams & leave types', scoped: false },
  { key: 'roles.manage', module: 'Settings', label: 'Manage roles & assign roles', scoped: false },
  { key: 'audit.view', module: 'Settings', label: 'View activity log', scoped: false },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const everything = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'all']));

// Created for every new organisation. Owner cannot be edited or deleted.
export const DEFAULT_ROLES = [
  {
    name: 'Owner',
    description: 'Business owner / super administrator. Full access to everything.',
    isOwner: true,
    permissions: everything,
  },
  {
    name: 'HR Manager',
    description: 'Manages people: employees, documents, attendance, leave — and prepares payroll.',
    permissions: {
      'dashboard.view': 'all',
      'employees.view': 'all',
      'employees.create': 'all',
      'employees.edit': 'all',
      'employees.exit': 'all',
      'documents.view': 'all',
      'documents.manage': 'all',
      'attendance.view': 'all',
      'attendance.review': 'all',
      'leave.view': 'all',
      'leave.approve': 'all',
      'payroll.view': 'all',
      'payroll.manage': 'all',
      'tasks.view': 'all',
      'tasks.assign': 'all',
      'reviews.view': 'all',
      'reviews.manage': 'all',
      'reviews.setup': 'all',
      'onboarding.manage': 'all',
    },
  },
  {
    name: 'Finance Officer',
    description: 'Handles money: invoices, payments, expenses, reports — and approves & pays payroll.',
    permissions: {
      'dashboard.view': 'all',
      'employees.view': 'all',
      'attendance.view': 'all',
      'leave.view': 'all',
      'customers.view': 'all',
      'invoices.view': 'all',
      'invoices.manage': 'all',
      'invoices.payments': 'all',
      'finance.view': 'all',
      'finance.manage': 'all',
      'payroll.view': 'all',
      'payroll.approve': 'all',
    },
  },
  {
    name: 'Operations Manager',
    description: 'Runs day-to-day operations, branches, teams and customer accounts.',
    permissions: {
      'dashboard.view': 'all',
      'employees.view': 'all',
      'attendance.view': 'all',
      'attendance.review': 'all',
      'leave.view': 'all',
      'leave.approve': 'all',
      'customers.view': 'all',
      'customers.manage': 'all',
      'invoices.view': 'all',
      'organization.manage': 'all',
      'tasks.view': 'all',
      'tasks.assign': 'all',
      'reviews.view': 'all',
      'reviews.manage': 'all',
    },
  },
  {
    name: 'Team Supervisor',
    description: 'Leads a team. Sees and approves only for their own team and its customers.',
    permissions: {
      'dashboard.view': 'team',
      'employees.view': 'team',
      'documents.view': 'team',
      'attendance.view': 'team',
      'attendance.review': 'team',
      'leave.view': 'team',
      'leave.approve': 'team',
      'customers.view': 'team',
      'customers.manage': 'team',
      'tasks.view': 'team',
      'tasks.assign': 'team',
      'reviews.view': 'team',
      'reviews.manage': 'team',
    },
  },
  {
    name: 'Employee',
    description: 'Regular staff. Clocks in, requests leave, sees own records and handles customers assigned to them.',
    permissions: {
      'customers.view': 'own',
      'customers.manage': 'own',
    },
  },
];

export const DEFAULT_LEAVE_TYPES = [
  { name: 'Annual leave', daysPerYear: 20, isPaid: true },
  { name: 'Sick leave', daysPerYear: 10, isPaid: true },
  { name: 'Casual leave', daysPerYear: 5, isPaid: true },
  { name: 'Unpaid leave', daysPerYear: 30, isPaid: false },
];

// What staff are rated on (1–5 each). Weights add up to 100. Editable in Settings → Reviews.
export const DEFAULT_REVIEW_CRITERIA = [
  { name: 'Quality of work', description: 'Accuracy, care and standard of what they deliver', weight: 30 },
  { name: 'Targets & results', description: 'Did they hit the goals agreed for this period?', weight: 30 },
  { name: 'Punctuality & attendance', description: 'On time, present, reliable', weight: 20 },
  { name: 'Teamwork & attitude', description: 'Helps others, communicates, takes ownership', weight: 20 },
];

// Two starter onboarding checklists. owner: who does it — the new joiner, or HR / the owner.
// day: days after the start date it's due (0 = first day). Editable in Onboarding → Checklists.
const EVERYONE_JOINER = [
  { title: 'Accept your Workard invite and set your password', owner: 'new_joiner', day: 0 },
  { title: 'Complete your profile: phone, address and emergency contact', owner: 'new_joiner', day: 1 },
  { title: 'Upload your ID, passport photo and certificates', owner: 'new_joiner', day: 2, description: 'On your profile → Documents' },
  { title: 'Clock in from the office once to test it', owner: 'new_joiner', day: 1 },
  { title: 'Read the staff handbook and policies', owner: 'new_joiner', day: 3 },
];
const EVERYONE_HR = [
  { title: 'Signed offer letter / contract on file', owner: 'hr', day: 0 },
  { title: 'Create work email and accounts', owner: 'hr', day: 0 },
  { title: 'Hold a welcome meeting', owner: 'hr', day: 1 },
  { title: 'Issue ID card and work equipment', owner: 'hr', day: 3 },
  { title: 'Add salary, bank and pension details for payroll', owner: 'hr', day: 5 },
  { title: 'Check in after the first week', owner: 'hr', day: 7 },
];

export const DEFAULT_ONBOARDING_TEMPLATES = [
  {
    name: 'New employee',
    description: 'For staff joining any team',
    suits: 'staff',
    items: [...EVERYONE_JOINER, { title: 'Meet your team and supervisor', owner: 'new_joiner', day: 1 }, ...EVERYONE_HR,
      { title: 'Assign to a team and set "Reports to"', owner: 'hr', day: 0 }],
  },
  {
    name: 'New manager',
    description: 'For supervisors and managers who will lead people',
    suits: 'managers',
    items: [
      ...EVERYONE_JOINER,
      { title: 'Meet each of your team members one-to-one', owner: 'new_joiner', day: 10 },
      { title: 'Learn how to approve leave, flagged clock-ins and reviews', owner: 'new_joiner', day: 3 },
      { title: 'Agree first-month goals with your own manager', owner: 'new_joiner', day: 7 },
      ...EVERYONE_HR,
      { title: 'Give the right role (e.g. Team Supervisor) and link their team', owner: 'hr', day: 0 },
      { title: 'Introduce them to their direct reports', owner: 'hr', day: 1 },
    ],
  },
];

export const DEFAULT_FINANCE_CATEGORIES = {
  income: ['Sales (not invoiced)', 'Services', 'Commission', 'Grants & loans', 'Other income'],
  expense: [
    'Rent',
    'Salaries',
    'Pension contributions',
    'Electricity & diesel',
    'Fuel & transport',
    'Logistics',
    'Inventory & stock',
    'Marketing',
    'Subscriptions & software',
    'Internet & phone',
    'Maintenance & repairs',
    'Bank charges',
    'Taxes & levies',
    'Miscellaneous',
  ],
};
