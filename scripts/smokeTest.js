// ============================================================
// Smoke test: runs the real API against your database and checks
// the main Phase 1, 2 and 3 flows end to end.
// Payroll payouts go to a FAKE Paystack (scripts/fakePaystack.js) — no real money.
//
//   npm test
//
// Needs: a working .env and `npm run db:init` done.
// Leave RESEND_API_KEY empty — codes are read from the dev outbox.
// Creates test data with unique emails each run (safe to re-run).
// ============================================================
process.env.RESEND_API_KEY = '';
process.env.NODE_ENV = 'development';

const crypto = await import('node:crypto');
const { startFakePaystack } = await import('./fakePaystack.js');
const PAYSTACK_KEY = `sk_test_${'a1b2c3d4e5'.repeat(3)}`;
const BILLING_KEY = `sk_test_${'w0rkard9z8'.repeat(3)}`; // Workard's own Paystack account (plans)
const fakePaystack = startFakePaystack({ validKey: PAYSTACK_KEY, billingKey: BILLING_KEY });
process.env.PAYSTACK_BASE_URL = fakePaystack.url; // must be set before the app loads
process.env.PAYSTACK_SECRET_KEY = BILLING_KEY;
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { default: app } = await import('../src/app.js');
const { devOutbox } = await import('../src/services/emailService.js');
const { pool } = await import('../src/config/db.js');

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const stamp = Date.now();

let passed = 0;
let failed = 0;
function check(label, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
  }
}

// A tiny "browser" that keeps its own cookies
function client() {
  const jar = {};
  return async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      jar[name] = rest.join('=');
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

const lastEmail = (to) => [...devOutbox].reverse().find((m) => m.to === to);
const codeFor = (to) => lastEmail(to)?.text.match(/\b(\d{6})\b/)?.[1];
const linkFor = (to) => lastEmail(to)?.text.match(/\/invite\/([a-f0-9]+)/)?.[1];

try {
  const owner = client();
  const anon = client(); // not logged in
  const ownerEmail = `owner${stamp}@test.ng`;

  console.log('\nSign up with 2FA');
  let r = await owner('POST', '/auth/register', { fullName: 'A', email: 'bad', password: 'x' });
  check('rejects invalid sign up with field errors', r.status === 422 && r.data.errors?.email, r.data);

  r = await owner('POST', '/auth/register', {
    fullName: 'Ada Okafor',
    organizationName: 'Ada Fashion House',
    email: ownerEmail,
    password: 'secret123',
    plan: 'enterprise',
  });
  check('sign up asks for an email code', r.status === 201 && r.data.requiresOtp && r.data.challengeToken, r.data);
  const signupChallenge = r.data.challengeToken;

  r = await owner('GET', '/auth/me');
  check('not logged in before the code is entered', r.status === 401);

  r = await owner('POST', '/auth/verify-otp', { challengeToken: signupChallenge, code: '000000' });
  check('wrong code is rejected', r.status === 400, r.data);

  r = await owner('POST', '/auth/verify-otp', { challengeToken: signupChallenge, code: codeFor(ownerEmail) });
  check('correct code logs in as Owner', r.status === 200 && r.data.role?.isOwner, r.data);
  check('owner has an employee profile', !!r.data.employee?.id, r.data);
  check('new organisation waits for payment', r.data.subscription?.status === 'pending_payment' && r.data.subscription.plan === 'enterprise', r.data.subscription);

  console.log('\nPaying for the plan (fake Paystack)');
  r = await owner('GET', '/dashboard');
  check('app is locked until the plan is paid (402)', r.status === 402 && r.data.code === 'SUBSCRIPTION_REQUIRED', r.status);
  r = await owner('GET', '/billing');
  check('billing page still works while locked', r.status === 200 && r.data.plans.length === 3 && r.data.plans[2].quote.amountKobo === 100_000_000, r.data);
  r = await owner('POST', '/billing/checkout', { plan: 'enterprise' });
  check('checkout returns a Paystack payment page for ₦1,000,000', r.status === 201 && r.data.authorizationUrl && r.data.amountKobo === 100_000_000 && r.data.kind === 'new', r.data);
  const firstRef = r.data.reference;
  r = await owner('POST', '/billing/verify', { reference: firstRef });
  check('not paid yet → still locked', r.data.status !== 'paid' && (await owner('GET', '/dashboard')).status === 402, r.data);
  fakePaystack.state.transactions[firstRef].status = 'success'; // the owner pays on Paystack
  const [verifyA, verifyB] = await Promise.all([
    owner('POST', '/billing/verify', { reference: firstRef }),
    owner('POST', '/billing/verify', { reference: firstRef }),
  ]);
  check('payment confirmed with Paystack (twice at once is fine)', verifyA.data.status === 'paid' && verifyB.data.status === 'paid', [verifyA.data, verifyB.data]);
  const [[paidRows]] = await pool.query("SELECT COUNT(*) AS n FROM billing_payments WHERE reference = ? AND status = 'paid'", [firstRef]);
  check('…and applied exactly once', Number(paidRows.n) === 1);
  r = await owner('GET', '/auth/me');
  check('plan is active for a year', r.data.subscription?.status === 'active' && r.data.subscription.daysLeft >= 364, r.data.subscription);
  check('app unlocked after paying', (await owner('GET', '/dashboard')).status === 200);

  console.log('\nLog in with 2FA');
  const owner2 = client();
  r = await owner2('POST', '/auth/login', { email: ownerEmail, password: 'wrong-pass1' });
  check('wrong password rejected', r.status === 401);
  r = await owner2('POST', '/auth/login', { email: ownerEmail, password: 'secret123' });
  check('right password asks for a code', r.data.requiresOtp && r.data.purpose === 'login', r.data);
  r = await owner2('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(ownerEmail) });
  check('login code works', r.status === 200 && r.data.user?.email === ownerEmail, r.data);
  r = await owner2('POST', '/auth/refresh');
  check('refresh token rotates', r.status === 200, r.data);

  console.log('\nOrganisation structure');
  r = await owner('GET', '/organization/structure');
  check('signup created 6 roles, leave types and Head Office', r.data.roles?.length === 6 && r.data.leaveTypes?.length === 4 && r.data.branches?.length === 1, r.data);
  const roles = Object.fromEntries(r.data.roles.map((x) => [x.name, x.id]));

  r = await owner('POST', '/organization/branches', {
    name: 'Wuse Office',
    latitude: 9.0765,
    longitude: 7.4986,
    radiusM: 100,
    officeIps: '10.10.10.10',
    clockInPolicy: 'both',
    workStart: '00:00',
    graceMinutes: 0,
  });
  check('create branch with location + office IP', r.status === 201, r.data);
  const branchId = r.data.id;

  r = await owner('POST', '/organization/departments', { name: 'Sales' });
  const deptId = r.data.id;
  check('create department', r.status === 201, r.data);

  console.log('\nEmployees & invites');
  const supEmail = `sup${stamp}@test.ng`;
  const staffEmail = `staff${stamp}@test.ng`;

  r = await owner('POST', '/employees', {
    firstName: 'Bola', lastName: 'Ade', email: supEmail, jobTitle: 'Sales Lead',
    branchId, departmentId: deptId, sendInvite: true, roleId: roles['Team Supervisor'],
  });
  check('create supervisor + send invite', r.status === 201 && r.data.inviteMessage?.startsWith('Invitation sent'), r.data);
  const supId = r.data.employee.id;

  r = await owner('POST', '/organization/teams', { name: 'Field Sales', departmentId: deptId, supervisorEmployeeId: supId });
  check('create team with supervisor', r.status === 201, r.data);
  const teamId = r.data.id;
  await owner('PATCH', `/employees/${supId}`, { teamId });

  r = await owner('POST', '/employees', {
    firstName: 'Chidi', lastName: 'Eze', email: staffEmail, branchId, departmentId: deptId, teamId,
    sendInvite: true, roleId: roles.Employee,
  });
  const staffId = r.data.employee.id;
  check('create team member + invite', r.status === 201, r.data);

  r = await owner('POST', '/employees', { firstName: 'Dayo', lastName: 'Out', email: `other${stamp}@test.ng`, branchId });
  const otherId = r.data.employee.id;
  check('create employee outside the team (no login)', r.status === 201, r.data);

  r = await owner('POST', '/employees', { firstName: 'X', lastName: 'Y', email: staffEmail });
  check('duplicate employee email blocked', r.status === 409, r.data);

  const sup = client();
  r = await sup('GET', `/invites/${linkFor(supEmail)}`);
  check('invite link shows organisation', r.data.organizationName === 'Ada Fashion House', r.data);
  r = await sup('POST', `/invites/${linkFor(supEmail)}/accept`, { password: 'weak' });
  check('weak password rejected on invite', r.status === 422, r.data);
  r = await sup('POST', `/invites/${linkFor(supEmail)}/accept`, { password: 'super123' });
  check('supervisor accepts invite and is logged in', r.status === 200 && r.data.role?.name === 'Team Supervisor', r.data);

  const staff = client();
  r = await staff('POST', `/invites/${linkFor(staffEmail)}/accept`, { password: 'staff1234' });
  check('staff accepts invite', r.status === 200 && r.data.role?.name === 'Employee', r.data);

  console.log('\nPermissions & scopes');
  r = await staff('GET', '/employees');
  check('regular employee cannot list employees', r.status === 403);
  r = await staff('GET', `/employees/${staffId}`);
  check('employee can see own profile', r.status === 200);
  r = await staff('GET', `/employees/${supId}`);
  check('employee cannot see a colleague', r.status === 403, r.data);

  r = await sup('GET', '/employees');
  const visible = r.data.employees?.map((e) => e.id) || [];
  check('supervisor sees their team only', visible.includes(staffId) && visible.includes(supId) && !visible.includes(otherId), visible);
  r = await sup('GET', `/employees/${otherId}`);
  check('supervisor cannot open someone outside the team', r.status === 404);
  r = await sup('POST', '/organization/branches', { name: 'Nope' });
  check('supervisor cannot manage organisation', r.status === 403);

  console.log('\nAttendance (location + office Wi-Fi)');
  r = await staff('POST', '/me/attendance/clock-in', { latitude: 9.2, longitude: 7.6, accuracy: 20 });
  check('clock-in away from office is flagged', r.status === 201 && r.data.record?.is_flagged === 1, r.data);
  check('flag explains why', /Outside the office area/.test(r.data.record?.flag_reason) && /office network/.test(r.data.record?.flag_reason), r.data.record?.flag_reason);
  check('clock-in after work start is late', r.data.record?.is_late === 1, r.data.record);
  r = await staff('POST', '/me/attendance/clock-in', {});
  check('cannot clock in twice', r.status === 409);

  r = await sup('GET', '/attendance/flagged');
  const flaggedRecord = r.data.find?.((a) => a.employee_id === staffId);
  check('supervisor sees the flagged clock-in', !!flaggedRecord, r.data);
  r = await staff('PATCH', `/attendance/${flaggedRecord.id}/review`, { decision: 'approved' });
  check('employee cannot review clock-ins', r.status === 403);
  r = await sup('PATCH', `/attendance/${flaggedRecord.id}/review`, { decision: 'approved', note: 'Was at a client site' });
  check('supervisor approves it', r.status === 200 && r.data.review_status === 'approved', r.data);

  r = await staff('POST', '/me/attendance/clock-out');
  check('clock out', r.status === 200 && r.data.record?.clock_out_at, r.data);

  r = await sup('GET', '/attendance');
  check('register shows team with statuses', r.data.summary?.total === 2, r.data.summary);

  console.log('\nLeave');
  const types = (await staff('GET', '/me/leave')).data;
  check('employee sees leave balances', types.balances?.length === 4, types);
  const annual = types.balances.find((b) => b.name === 'Annual leave');

  // Next Monday → Wednesday (3 working days)
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  const fmt = (x) => x.toISOString().slice(0, 10);
  const start = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12));
  const end = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2, 12));

  r = await staff('POST', '/me/leave', { leaveTypeId: annual.leaveTypeId, startDate: start, endDate: end, reason: 'Family event' });
  check('request 3 days of annual leave', r.status === 201 && r.data.days === 3, r.data);
  const leaveId = r.data.id;
  r = await staff('POST', '/me/leave', { leaveTypeId: annual.leaveTypeId, startDate: start, endDate: start });
  check('overlapping leave is blocked', r.status === 409, r.data);
  r = await staff('POST', '/me/leave', { leaveTypeId: annual.leaveTypeId, startDate: start, endDate: fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 60, 12)) });
  check('cannot request more than the balance', [409, 422].includes(r.status), r.data);

  r = await sup('PATCH', `/leave/${leaveId}/review`, { decision: 'approved' });
  check('supervisor approves leave', r.status === 200 && r.data.status === 'approved', r.data);

  // ================= PHASE 2 =================
  console.log('\nCRM: customers & scopes');
  r = await owner('POST', '/customers', { name: 'Zenith Foods Ltd', type: 'business', email: `zenith${stamp}@test.ng`, phone: '0803 111 2222', stage: 'lead', assignedEmployeeId: staffId });
  check('owner creates customer assigned to staff', r.status === 201 && r.data.assigned_employee_id === staffId, r.data);
  const custA = r.data.id;
  r = await owner('POST', '/customers', { name: 'Other Branch Client', assignedEmployeeId: otherId });
  const custC = r.data.id;
  r = await owner('POST', '/customers', { name: 'No Email Ventures', phone: '08099998888' });
  check('customer with no assignee defaults to the creator', r.data.assigned_name?.startsWith('Ada'), r.data);
  const custNoEmail = r.data.id;

  r = await staff('POST', '/customers', { name: 'Staff Lead', assignedEmployeeId: otherId });
  check('employee-created customer is forced onto themselves', r.status === 201 && r.data.assigned_employee_id === staffId, r.data);
  r = await staff('GET', '/customers');
  const staffSees = r.data.customers?.map((c) => c.id) || [];
  check('employee sees only accounts assigned to them', staffSees.includes(custA) && !staffSees.includes(custC) && staffSees.length === 2, staffSees);
  r = await sup('GET', '/customers');
  const supSees = r.data.customers?.map((c) => c.id) || [];
  check('supervisor sees their team\'s accounts', supSees.includes(custA) && !supSees.includes(custC), supSees);
  r = await sup('PATCH', `/customers/${custA}`, { assignedEmployeeId: otherId });
  check('supervisor cannot assign outside their team', r.status === 422, r.data);
  r = await staff('GET', `/customers/${custC}`);
  check('employee cannot open another person\'s customer', r.status === 404);

  const today = new Date().toISOString().slice(0, 10);
  r = await staff('POST', `/customers/${custA}/activity`, { type: 'complaint', subject: 'Late delivery', details: 'Order 44 arrived 2 days late', followUpOn: today });
  check('log a complaint with a follow-up', r.status === 201 && r.data.status === 'open', r.data);
  const caseId = r.data.id;
  r = await sup('GET', '/customers/cases');
  check('supervisor sees the open complaint', r.data.some?.((c) => c.id === caseId), r.data);
  r = await staff('GET', '/customers/follow-ups');
  check('follow-up shows in the list', r.data.some?.((c) => c.id === caseId), r.data);
  r = await staff('PATCH', `/customers/activity/${caseId}/resolve`);
  check('resolve the complaint', r.data.status === 'resolved', r.data);
  r = await staff('PATCH', `/customers/activity/${caseId}/follow-up-done`);
  check('mark follow-up done', r.data.follow_up_done === 1, r.data);

  console.log('\nInvoices (kobo maths, numbering, sending)');
  r = await staff('GET', '/invoices');
  check('employee cannot see invoices', r.status === 403);
  r = await owner('POST', '/invoices', {
    customerId: custA,
    items: [
      { description: 'Cold-room rental (Nov)', quantity: 2, unitPrice: 150000 },
      { description: 'Delivery', quantity: 1, unitPrice: 12500.5 },
    ],
    discount: 10000,
    taxRate: 7.5,
  });
  // subtotal 312,500.50 − 10,000 = 302,500.50; VAT 7.5% = 22,687.54 (rounded); total 325,188.04
  check('invoice totals are exact (kobo)', r.status === 201 && r.data.subtotal_kobo === 31250050 && r.data.tax_kobo === 2268754 && r.data.total_kobo === 32518804, r.data);
  check('invoice gets the first number', r.data.invoice_number === 'INV-0001', r.data.invoice_number);
  check('new invoice is a draft', r.data.status === 'draft');
  const inv1 = r.data.id;

  const many = await Promise.all(
    [1, 2, 3, 4, 5].map(() => owner('POST', '/invoices', { customerId: custA, items: [{ description: 'X', quantity: 1, unitPrice: 1000 }] }))
  );
  const numbers = many.map((m) => m.data.invoice_number);
  check('5 invoices created at the same time get 5 different numbers', new Set(numbers).size === 5, numbers);
  await owner('DELETE', `/invoices/${many[4].data.id}`);

  r = await owner('POST', `/invoices/${inv1}/send`, { channel: 'email' });
  check('email the invoice to the customer', r.status === 200 && /\/i\/[a-f0-9]{32}$/.test(r.data.publicUrl), r.data);
  check('email went out with the link', lastEmail(`zenith${stamp}@test.ng`)?.text.includes('/i/'));
  const token = r.data.publicUrl.split('/i/')[1];

  r = await owner('POST', '/invoices', { customerId: custNoEmail, items: [{ description: 'Y', quantity: 1, unitPrice: 500 }] });
  r = await owner('POST', `/invoices/${r.data.id}/send`, { channel: 'email' });
  check('cannot email a customer with no email', r.status === 422, r.data);

  r = await anon('GET', `/public/invoices/${token}`);
  check('customer can open the public link without logging in', r.status === 200 && r.data.total_kobo === 32518804, r.data);
  check('public link hides internal fields', r.data.organization_id === undefined && r.data.id === undefined && r.data.items?.length === 2);
  r = await owner('GET', `/invoices/${inv1}`);
  check('invoice shows as viewed and customer promoted', r.data.viewed_at && r.data.status === 'sent', r.data);
  r = await owner('GET', `/customers/${custA}`);
  check('lead became a customer when invoiced', r.data.stage === 'customer', r.data.stage);

  console.log('\nPayments (idempotency, locking, no overpayment)');
  const reqId = `req-${stamp}-1`;
  r = await owner('POST', `/invoices/${inv1}/payments`, { amount: 100000, paidOn: today, method: 'transfer', requestId: reqId });
  check('record part payment', r.status === 201 && !r.data.duplicate, r.data);
  r = await owner('POST', `/invoices/${inv1}/payments`, { amount: 100000, paidOn: today, method: 'transfer', requestId: reqId });
  check('same request sent twice is saved only once', r.status === 200 && r.data.duplicate === true, r.data);
  r = await owner('GET', `/invoices/${inv1}`);
  check('invoice is partially paid with ₦100,000 paid', r.data.status === 'partially_paid' && r.data.amount_paid_kobo === 10000000 && r.data.payments.length === 1, r.data);

  r = await owner('POST', `/invoices/${inv1}/payments`, { amount: 999999, paidOn: today });
  check('overpayment is refused', r.status === 422, r.data);

  const balanceNaira = (32518804 - 10000000) / 100;
  const race = await Promise.all([
    owner('POST', `/invoices/${inv1}/payments`, { amount: balanceNaira, paidOn: today, requestId: `race-a-${stamp}` }),
    owner('POST', `/invoices/${inv1}/payments`, { amount: balanceNaira, paidOn: today, requestId: `race-b-${stamp}` }),
  ]);
  const okCount = race.filter((x) => x.status === 201).length;
  check('two people paying the full balance at once: only one succeeds', okCount === 1, race.map((x) => x.status));
  r = await owner('GET', `/invoices/${inv1}`);
  check('invoice is paid, never overpaid', r.data.status === 'paid' && r.data.amount_paid_kobo === 32518804, r.data);

  r = await owner('PUT', `/invoices/${inv1}`, { customerId: custA, issueDate: today, dueDate: today, items: [{ description: 'Z', quantity: 1, unitPrice: 1 }] });
  check('paid invoice cannot be edited', r.status === 409);
  r = await owner('POST', `/invoices/${inv1}/void`);
  check('invoice with payments cannot be voided', r.status === 409);
  const lastPayment = (await owner('GET', `/invoices/${inv1}`)).data.payments.at(-1);
  r = await owner('DELETE', `/invoices/payments/${lastPayment.id}`);
  r = await owner('GET', `/invoices/${inv1}`);
  check('removing a payment re-adds the totals', r.data.status === 'partially_paid' && r.data.amount_paid_kobo === 10000000, r.data);
  r = await owner('DELETE', `/invoices/${inv1}`);
  check('sent invoice cannot be deleted', r.status === 409);

  r = await owner('POST', '/invoices', { customerId: custA, issueDate: '2026-01-05', dueDate: '2026-01-20', items: [{ description: 'Old', quantity: 1, unitPrice: 2000 }] });
  await owner('POST', `/invoices/${r.data.id}/send`, { channel: 'link' });
  r = await owner('GET', '/invoices?filter=overdue');
  check('unpaid past-due invoice shows as overdue', r.data.invoices?.some((i) => i.display_status === 'overdue') && r.data.summary.overdueCount >= 1, r.data.summary);

  console.log('\nFinance');
  const cats = (await owner('GET', '/finance/categories')).data;
  const rent = cats.find((c) => c.name === 'Rent');
  const services = cats.find((c) => c.name === 'Services');
  r = await owner('POST', '/finance/entries', { type: 'expense', categoryId: rent.id, amount: 50000, entryDate: today, description: 'November rent', requestId: `exp-${stamp}` });
  check('record an expense', r.status === 201, r.data);
  const firstEntry = r.data.id;
  r = await owner('POST', '/finance/entries', { type: 'expense', categoryId: rent.id, amount: 50000, entryDate: today, description: 'November rent', requestId: `exp-${stamp}` });
  check('same expense sent twice is saved once', r.data.id === firstEntry, r.data);
  r = await owner('POST', '/finance/entries', { type: 'income', categoryId: rent.id, amount: 1, entryDate: today, description: 'Wrong' });
  check('income cannot use an expense category', r.status === 422, r.data);
  await owner('POST', '/finance/entries', { type: 'income', categoryId: services.id, amount: 20000, entryDate: today, description: 'Consulting' });

  r = await owner('GET', `/finance/summary?month=${today.slice(0, 7)}`);
  // revenue = ₦100,000 invoice payment + ₦20,000 other income; expenses ₦50,000
  check('monthly report adds up', r.data.revenueKobo === 12000000 && r.data.expensesKobo === 5000000 && r.data.profitKobo === 7000000, r.data);
  check('report includes 6-month trend', r.data.trend?.length === 6);
  r = await staff('GET', '/finance/summary');
  check('employee cannot see finance', r.status === 403);

  r = await owner('GET', '/dashboard');
  check('owner dashboard shows money & customers', r.data.money?.revenueKobo === 12000000 && r.data.customers?.byStage, r.data.money);
  r = await sup('GET', '/dashboard');
  check('supervisor dashboard hides money', r.data.money === null && r.data.customers !== null, { money: r.data.money });

  // ================= PHASE 3: PAYROLL =================
  console.log('\nPayroll: people & pay structures');
  const thisMonth = today.slice(0, 7);
  const lastMonthDate = new Date();
  lastMonthDate.setDate(1);
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

  // An HR manager (prepares payroll) and a finance officer (approves & pays) — maker–checker
  const hrEmail = `hr${stamp}@test.ng`;
  const finEmail = `fin${stamp}@test.ng`;
  await owner('POST', '/employees', { firstName: 'Hauwa', lastName: 'HR', email: hrEmail, branchId, sendInvite: true, roleId: roles['HR Manager'] });
  await owner('POST', '/employees', { firstName: 'Femi', lastName: 'Finance', email: finEmail, branchId, sendInvite: true, roleId: roles['Finance Officer'] });
  const hr = client();
  const fin = client();
  await hr('POST', `/invites/${linkFor(hrEmail)}/accept`, { password: 'hrpass123' });
  r = await fin('POST', `/invites/${linkFor(finEmail)}/accept`, { password: 'finpass123' });
  check('HR manager and finance officer join', r.data.role?.name === 'Finance Officer', r.data);

  r = await staff('GET', `/employees/${staffId}/pay`);
  check('regular employee cannot see salaries', r.status === 403);

  r = await hr('PUT', `/employees/${staffId}/pay`, {
    basic: 300000, housing: 150000, transport: 50000, annualRent: 1200000,
    bankName: 'GTBank', bankCode: '058', accountNumber: '0123456789', accountName: 'Chidi Eze',
    pfaName: 'Stanbic IBTC Pensions', pensionPin: 'PEN100200300400',
    items: [],
  });
  // ₦500k/month: pension ₦40k; taxable 6m − 480k − rent relief 240k = 5.28m → tax ₦740,400/yr → ₦61,700/month
  check('PAYE matches the 2026 bands (₦61,700)', r.status === 200 && r.data.preview?.paye === 6170000, r.data.preview);
  check('net pay ₦398,300, employer pension ₦50,000', r.data.preview?.net === 39830000 && r.data.preview?.pensionEmployer === 5000000, r.data.preview);
  check('Paystack recipient code is never sent to the browser', r.data.pay && !('paystack_recipient_code' in r.data.pay));

  r = await hr('PUT', `/employees/${supId}/pay`, {
    basic: 120000, housing: 40000, transport: 20000,
    bankName: 'Access Bank', accountNumber: '1234567890', accountName: 'Bola Ade',
    items: [{ type: 'allowance', name: 'Phone', amount: 10000 }, { type: 'deduction', name: 'Staff loan', amount: 15000 }],
  });
  check('pay with allowance & deduction saved', r.status === 200 && r.data.items?.length === 2, r.data);

  r = await hr('PUT', `/employees/${staffId}/pay`, { basic: -5, items: [] });
  check('negative salary rejected', r.status === 422);

  r = await staff('GET', `/employees/${supId}/pay`);
  check('staff cannot see a colleague\'s salary', r.status === 403, r.status);

  // The calculator on its own (pure maths, amounts in kobo)
  const { calculatePay, annualTax } = await import('../src/utils/payrollCalc.js');
  const calcSettings = { payeEnabled: true, pensionEnabled: true, pensionEmployeeRate: 8, pensionEmployerRate: 10, nhfEnabled: false, nhfRate: 2.5 };
  const naira = (n) => n * 100;
  const basePay = { basic: naira(300000), housing: naira(150000), transport: naira(50000), allowances: 0, otherDeductions: 0, annualRent: 0 };
  check('no tax on the first ₦800k a year', annualTax(naira(800000)) === 0);
  check('₦3m a year → ₦330,000 tax (15% band)', annualTax(naira(3000000)) === naira(330000));
  check('minimum-wage earner pays no PAYE', calculatePay({ ...basePay, basic: naira(70000), housing: 0, transport: 0 }, calcSettings).paye === 0);
  check('rent relief is capped at ₦500,000', calculatePay({ ...basePay, annualRent: naira(10000000) }, calcSettings).rentRelief === naira(500000));
  const half = calculatePay(basePay, calcSettings, { payableFraction: 11 / 22 });
  check('half the working days → half the fixed pay', half.gross === naira(250000) && half.proration === naira(250000), half);

  console.log('\nPayroll runs (draft → approve)');
  r = await hr('POST', '/payroll', { period: thisMonth });
  check('HR prepares this month\'s payroll', r.status === 201 && r.data.status === 'draft', r.data);
  const run1 = r.data.id;
  const staffItem = r.data.items?.find((i) => i.employee_id === staffId);
  check('only staff with a salary are included', r.data.items?.length === 2, r.data.items?.length);
  check('payslip numbers match the preview', staffItem?.paye_kobo === 6170000 && staffItem?.net_kobo === 39830000, staffItem);
  check('people without a salary are listed as a warning', r.data.missingPay?.some((m) => m.id === otherId));

  r = await hr('POST', '/payroll', { period: thisMonth });
  check('cannot create the same month twice', r.status === 409, r.data);

  const [raceA, raceB] = await Promise.all([hr('POST', '/payroll', { period: '2026-01' }), hr('POST', '/payroll', { period: '2026-01' })]);
  check('two "Prepare" clicks at once make only one run', [raceA.status, raceB.status].sort().join() === '201,409', [raceA.status, raceB.status]);
  await hr('POST', `/payroll/${(raceA.status === 201 ? raceA : raceB).data.id}/cancel`);

  r = await hr('PATCH', `/payroll/items/${staffItem.id}`, { bonus: 50000, oneOffDeduction: 0 });
  const bonused = r.data.items?.find((i) => i.employee_id === staffId);
  check('one-off bonus added and tax recalculated', bonused?.bonus_kobo === 5000000 && bonused?.paye_kobo > 6170000, bonused);

  r = await hr('POST', `/payroll/${run1}/approve`);
  check('HR (preparer) cannot approve', r.status === 403);
  r = await fin('POST', `/payroll/${run1}/approve`);
  check('finance officer approves it (maker–checker)', r.status === 200 && r.data.status === 'approved', r.data);
  r = await hr('PATCH', `/payroll/items/${staffItem.id}`, { bonus: 0, oneOffDeduction: 0 });
  check('approved payroll is locked', r.status === 409);

  console.log('\nPaying through Paystack (fake server)');
  r = await fin('POST', `/payroll/${run1}/pay-paystack`);
  check('cannot pay with Paystack before connecting it', r.status === 409, r.data);
  r = await fin('POST', '/payroll/settings/paystack', { secretKey: 'not-a-key' });
  check('a wrong-looking key is refused', r.status === 422);
  r = await fin('POST', '/payroll/settings/paystack', { secretKey: 'sk_test_wrongwrongwrongwrongwrong' });
  check('a key Paystack rejects is not saved', r.status === 422, r.data);
  r = await fin('POST', '/payroll/settings/paystack', { secretKey: PAYSTACK_KEY });
  check('connect Paystack (key checked, only last 4 shown)', r.data.paystackConnected === true && r.data.paystackKeyLast4 === PAYSTACK_KEY.slice(-4) && !JSON.stringify(r.data).includes(PAYSTACK_KEY), r.data);
  const [[keyRow]] = await pool.query('SELECT paystack_secret_enc FROM payroll_settings WHERE organization_id = (SELECT organization_id FROM payroll_runs WHERE id = ?)', [run1]);
  check('the key is stored encrypted', keyRow.paystack_secret_enc && !keyRow.paystack_secret_enc.includes(PAYSTACK_KEY));

  r = await fin('POST', `/payroll/${run1}/pay-paystack`);
  check('missing bank code blocks the payout before anything is sent', r.status === 422 && /Bola Ade/.test(r.data.message) && fakePaystack.state.transfers.length === 0, r.data);

  // Fix Bola's bank (choose from list), then cancel and redo the payroll so the new details are used
  r = await hr('PUT', `/employees/${supId}/pay`, {
    basic: 120000, housing: 40000, transport: 20000, bankName: 'Access Bank', bankCode: '044', accountNumber: '1234567890', accountName: 'Bola Ade',
    items: [{ type: 'allowance', name: 'Phone', amount: 10000 }, { type: 'deduction', name: 'Staff loan', amount: 15000 }],
  });
  r = await fin('GET', `/payroll/${run1}`);
  check('bank details on an approved payroll don\'t change when the profile does', !r.data.items.find((i) => i.employee_id === supId).bank_code, r.data.items);
  r = await hr('POST', `/payroll/${run1}/cancel`);
  check('approved payroll can be cancelled', r.data.status === 'cancelled', r.data);
  r = await hr('POST', '/payroll', { period: thisMonth });
  const run2 = r.data.id;
  check('bonus is gone on a fresh run', r.data.items?.find((i) => i.employee_id === staffId)?.bonus_kobo === 0);
  await fin('POST', `/payroll/${run2}/approve`);

  const [payA, payB] = await Promise.all([fin('POST', `/payroll/${run2}/pay-paystack`), fin('POST', `/payroll/${run2}/pay-paystack`)]);
  check('double-clicking "Pay" sends each salary only once', [payA.status, payB.status].sort().join() === '200,409' && fakePaystack.state.transfers.length === 2, [payA.status, payB.status, fakePaystack.state.transfers.length]);
  r = await fin('GET', `/payroll/${run2}`);
  check('run is processing until Paystack confirms', r.data.status === 'processing' && r.data.items.every((i) => i.payment_status === 'processing'), r.data.status);
  const sentAmount = fakePaystack.state.transfers.find((t) => t.amount === 39830000);
  check('Paystack was asked to send the exact net pay in kobo', !!sentAmount, fakePaystack.state.transfers);

  const items2 = r.data.items;
  const staffRef = items2.find((i) => i.employee_id === staffId).transfer_reference;
  const supRef = items2.find((i) => i.employee_id === supId).transfer_reference;
  const orgId = r.data.organization_id;
  const webhook = async (event, reference, signWith = PAYSTACK_KEY) => {
    const body = JSON.stringify({ event, data: { reference, reason: 'Account closed' } });
    const signature = crypto.createHmac('sha512', signWith).update(body).digest('hex');
    const res = await fetch(`${BASE}/webhooks/paystack/${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body });
    return res.status;
  };

  check('webhook with a forged signature is rejected', (await webhook('transfer.success', staffRef, 'sk_test_forged')) === 401);
  check('transfer.success webhook accepted', (await webhook('transfer.success', staffRef)) === 200);
  check('transfer.failed webhook accepted', (await webhook('transfer.failed', supRef)) === 200);
  r = await fin('GET', `/payroll/${run2}`);
  check('one paid, one failed — run still not complete', r.data.status === 'processing' && Number(r.data.paid_count) === 1 && Number(r.data.failed_count) === 1, r.data);

  const before = fakePaystack.state.transfers.length;
  r = await fin('POST', `/payroll/${run2}/pay-paystack`);
  const retried = fakePaystack.state.transfers.slice(before);
  check('retry sends ONLY the failed one, with the SAME reference', retried.length === 1 && retried[0].reference === supRef, retried);
  await webhook('transfer.success', supRef);
  r = await fin('GET', `/payroll/${run2}`);
  check('all confirmed → payroll is paid', r.data.status === 'paid' && r.data.expenses_recorded === 1, r.data.status);
  await webhook('transfer.success', supRef); // Paystack can send the same event twice

  const [salaryRows] = await pool.query(`SELECT COUNT(*) AS n, SUM(amount_kobo) AS total FROM finance_entries WHERE request_id = ?`, [`payroll-${run2}-salaries`]);
  check('gross salaries recorded once as an expense', Number(salaryRows[0].n) === 1 && Number(salaryRows[0].total) === Number(r.data.gross_kobo), salaryRows[0]);
  const [pensionRows] = await pool.query(`SELECT COUNT(*) AS n FROM finance_entries WHERE request_id = ?`, [`payroll-${run2}-pension`]);
  check('employer pension recorded once as an expense', Number(pensionRows[0].n) === 1);
  check('staff are emailed that their payslip is ready', lastEmail(staffEmail)?.subject.includes('payslip'));

  console.log('\nPaying by bank upload + payslips');
  r = await hr('POST', '/payroll', { period: lastMonth });
  const run3 = r.data.id;
  r = await owner('POST', `/payroll/${run3}/approve`);
  check('owner can approve (one-person businesses)', r.data.status === 'approved', r.data);
  r = await fin('GET', `/payroll/${run3}/bank-schedule`);
  check('bank upload schedule has account numbers and net pay', r.data.rows?.length === 2 && r.data.rows.some((x) => x.accountNumber === '0123456789' && x.amountKobo === 39830000), r.data);
  r = await fin('POST', `/payroll/${run3}/mark-paid`, { paidOn: today, method: 'bank_upload' });
  check('mark as paid after bank upload', r.data.status === 'paid' && r.data.items.every((i) => i.payment_status === 'paid'), r.data.status);
  r = await fin('GET', `/payroll/${run3}/remittances`);
  check('remittance summary: PAYE and pension per PFA', r.data.payeKobo > 0 && r.data.pension.some((p) => p.pfa === 'Stanbic IBTC Pensions'), r.data);

  r = await staff('GET', '/me/payslips');
  check('employee sees their own payslips', r.data.length === 2, r.data.length);
  const myPayslip = r.data[0].id;
  r = await staff('GET', `/payroll/payslips/${myPayslip}`);
  check('employee opens their payslip', r.status === 200 && r.data.net_kobo > 0);
  const supPayslip = (await fin('GET', `/payroll/${run3}`)).data.items.find((i) => i.employee_id === supId).id;
  r = await staff('GET', `/payroll/payslips/${supPayslip}`);
  check('employee cannot open a colleague\'s payslip', r.status === 404);

  r = await owner('GET', `/finance/summary?month=${thisMonth}`);
  check('salaries now show in the profit report', r.data.expensesByCategory?.some((c) => c.name === 'Salaries'), r.data.expensesByCategory);
  r = await owner('GET', `/finance/entries?month=${thisMonth}&type=expense`);
  const salaryEntry = r.data.find((e) => e.request_id?.startsWith('payroll-'));
  r = await owner('DELETE', `/finance/entries/${salaryEntry.id}`);
  check('payroll expenses cannot be deleted from Finance', r.status === 400, r.status);

  console.log('\nTasks');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  r = await staff('POST', '/tasks', { title: 'Call back Mrs Eze', checklist: [] });
  check('employee creates a task for themselves', r.status === 201 && r.data.assigned_employee_id === staffId, r.data);
  const ownTask = r.data.id;
  r = await staff('POST', '/tasks', { title: 'Do my job', assignedEmployeeId: supId });
  check('employee cannot give tasks to others', r.status === 422 && r.data.errors?.assignedEmployeeId, r.data);

  r = await sup('POST', '/tasks', {
    title: 'Visit Wuse market stores', assignedEmployeeId: staffId, dueDate: yesterday, priority: 'high',
    checklist: ['Shoprite', 'Next Cash & Carry'],
  });
  check('supervisor gives a task to their team member', r.status === 201 && r.data.checklist.length === 2 && r.data.canManage, r.data);
  const supTask = r.data.id;
  check('assignee is emailed about the new task', lastEmail(staffEmail)?.subject.startsWith('New task: Visit Wuse market stores'), lastEmail(staffEmail));
  r = await sup('POST', '/tasks', { title: 'Not my team', assignedEmployeeId: otherId });
  check('supervisor cannot give tasks outside their team', r.status === 422);

  r = await staff('GET', '/tasks?view=mine&status=open');
  check('my tasks lists both, overdue first', r.data.tasks?.length === 2 && r.data.tasks[0].id === supTask, r.data.tasks?.map((t) => t.id));
  r = await staff('GET', '/tasks/counts');
  check('counts show the overdue task', r.data.mine.overdue === 1 && r.data.mine.open === 2 && r.data.team === null, r.data);

  // An organisation created before tasks existed: its Owner role has no task permissions saved
  await pool.query(
    "UPDATE roles SET permissions = JSON_REMOVE(permissions, '$.\"tasks.assign\"', '$.\"tasks.view\"') WHERE is_owner = 1 AND organization_id = (SELECT organization_id FROM employees WHERE id = ?)",
    [staffId]
  );
  r = await owner('GET', '/tasks/assignees');
  check('Owner can pick anyone, even before db:sync', r.data.some((p) => p.id === staffId) && r.data.some((p) => p.id === otherId), r.data);
  r = await owner('POST', '/tasks', { title: 'Owner gives Chidi a task', assignedEmployeeId: staffId });
  check('Owner gives any employee a task', r.status === 201 && r.data.assigned_employee_id === staffId, r.data);

  r = await owner('POST', '/tasks', { title: 'Owner private task' });
  const ownerTask = r.data.id;
  r = await staff('GET', `/tasks/${ownerTask}`);
  check('staff cannot open someone else\'s task', r.status === 404);
  r = await sup('GET', '/tasks?view=team');
  check('supervisor sees team tasks only', r.data.tasks.some((t) => t.id === ownTask) && !r.data.tasks.some((t) => t.id === ownerTask), r.data.tasks.map((t) => t.id));

  r = await staff('PATCH', `/tasks/${supTask}`, { title: 'Changed' });
  check('assignee cannot edit a task their manager set', r.status === 403);
  r = await staff('GET', `/tasks/${supTask}`);
  r = await staff('PATCH', `/tasks/checklist/${r.data.checklist[0].id}`, { isDone: true });
  check('assignee ticks a checklist item', r.status === 200 && r.data[0].is_done === 1, r.data);
  r = await staff('POST', `/tasks/${supTask}/comments`, { body: 'Shoprite done, Next is closed today' });
  check('assignee comments', r.status === 201 && r.data.length === 1);
  r = await staff('PATCH', `/tasks/${supTask}/status`, { status: 'cancelled' });
  check('assignee cannot cancel a task', r.status === 403);
  r = await staff('PATCH', `/tasks/${supTask}/status`, { status: 'done' });
  check('assignee marks it done', r.data.status === 'done' && r.data.completed_at, r.data.status);
  r = await sup('GET', `/tasks/${supTask}`);
  check('supervisor sees the comment and the ticked item', r.data.comments[0]?.body.startsWith('Shoprite') && r.data.checklist_done === 1, r.data);
  r = await staff('DELETE', `/tasks/${supTask}`);
  check('assignee cannot delete it', r.status === 403);

  // "Reports to": a direct manager can assign even without a tasks permission
  await owner('PATCH', `/employees/${otherId}`, { managerId: staffId });
  r = await staff('POST', '/tasks', { title: 'Count stock', assignedEmployeeId: otherId });
  check('direct manager can give tasks to their report', r.status === 201, r.data);

  console.log('\nRepeating tasks & daily jobs');
  r = await sup('POST', '/tasks/recurring', { title: 'Weekly sales report', assignedEmployeeId: staffId, frequency: 'weekly' });
  check('weekly task needs a weekday', r.status === 422 && r.data.errors?.weekday, r.data);
  r = await sup('POST', '/tasks/recurring', { title: 'Weekly sales report', assignedEmployeeId: staffId, frequency: 'weekly', weekday: 1, startsOn: '2027-03-01' });
  check('repeating task set up (first Monday found)', r.status === 201 && r.data.next_run_on === '2027-03-01', r.data);
  const recId = r.data.id;
  const { generateRecurringTasks } = await import('../src/services/taskService.js');
  const recCount = async () => (await pool.query('SELECT due_date FROM tasks WHERE recurring_task_id = ? ORDER BY due_date', [recId]))[0];
  await generateRecurringTasks('2027-03-01');
  await generateRecurringTasks('2027-03-01');
  check('runs twice on the same day → one task', (await recCount()).length === 1);
  await pool.query('UPDATE recurring_tasks SET next_run_on = ? WHERE id = ?', ['2027-03-08', recId]);
  await generateRecurringTasks('2027-03-23'); // server "off" for 2 weeks
  const recTasks = await recCount();
  check('after a gap only the latest missed date gets a task', recTasks.length === 2 && recTasks[1].due_date === '2027-03-22', recTasks);
  r = await sup('GET', '/tasks/recurring');
  check('next date moves on', r.data.find((x) => x.id === recId)?.next_run_on === '2027-03-29', r.data);
  await pool.query('DELETE FROM tasks WHERE recurring_task_id = ?', [recId]); // keep later counts clean
  await sup('DELETE', `/tasks/recurring/${recId}`);

  await sup('POST', '/tasks', { title: 'Overdue thing', assignedEmployeeId: staffId, dueDate: yesterday });
  const { sendTaskDigests } = await import('../src/services/schedulerService.js');
  await sendTaskDigests(today);
  check('morning email lists due & overdue tasks', /^Your tasks today/.test(lastEmail(staffEmail)?.subject) && /Overdue thing/.test(lastEmail(staffEmail)?.text), lastEmail(staffEmail));
  r = await anon('POST', '/jobs/daily');
  check('daily-jobs endpoint refuses calls without the secret', r.status === 401);

  console.log('\nPerformance reviews');
  r = await staff('GET', '/reviews/settings');
  check('default criteria (weights add to 100)', r.data.criteria?.length === 4 && r.data.criteria.reduce((s, c) => s + c.weight, 0) === 100 && r.data.frequency === 'monthly', r.data);
  const criteria = r.data.criteria;
  r = await hr('PUT', '/reviews/settings', { frequency: 'monthly', selfReview: true, criteria: criteria.map((c) => ({ ...c, weight: 10 })) });
  check('weights that don\'t add to 100 are refused', r.status === 422);
  r = await staff('PUT', '/reviews/settings', { frequency: 'monthly', selfReview: true, criteria });
  check('staff cannot change review settings', r.status === 403);

  r = await sup('GET', `/reviews/reviewables?period=${thisMonth}`);
  const reviewable = r.data.map((x) => x.id);
  check('supervisor can review their team, not themselves', reviewable.includes(staffId) && !reviewable.includes(supId) && !reviewable.includes(otherId), reviewable);
  r = await sup('POST', '/reviews/start', { period: '2026-Q4', employeeIds: [staffId] });
  check('a quarter is refused when reviews are monthly', r.status === 422);
  r = await sup('POST', '/reviews/start', { period: thisMonth, employeeIds: [staffId, otherId] });
  check('start this month\'s review (outsider skipped)', r.data.created === 1 && r.data.skipped[0]?.employeeId === otherId, r.data);
  const reviewId = r.data.ids[0];
  check('employee is emailed to rate themselves', /rate yourself/.test(lastEmail(staffEmail)?.subject));

  const [startA, startB] = await Promise.all([
    owner('POST', '/reviews/start', { period: thisMonth, employeeIds: [supId] }),
    owner('POST', '/reviews/start', { period: thisMonth, employeeIds: [supId] }),
  ]);
  check('starting the same review twice at once makes one', startA.data.created + startB.data.created === 1, [startA.data, startB.data]);
  const supReviewId = startA.data.ids[0] || startB.data.ids[0];

  r = await staff('GET', `/reviews/${reviewId}`);
  check('employee opens their review and can rate themselves', r.data.canSelfReview && r.data.scores.length === 4 && !r.data.canManagerReview, r.data);
  const scoreIds = r.data.scores.map((s) => s.id);
  await staff('PUT', `/reviews/${reviewId}/self`, { scores: [{ id: scoreIds[0], rating: 5 }], summary: 'Good month', submit: false });
  r = await sup('GET', `/reviews/${reviewId}`);
  check('manager cannot see self-ratings before they are handed in', r.data.scores[0].self_rating === null && r.data.self_summary === null, r.data.scores[0]);
  r = await sup('PUT', `/reviews/${reviewId}/manager`, { scores: [], submit: true });
  check('manager waits for the self-assessment', r.status === 409);
  r = await staff('PUT', `/reviews/${reviewId}/self`, { scores: [{ id: scoreIds[0], rating: 5 }], submit: true });
  check('self-assessment needs every item rated', r.status === 422);
  r = await staff('PUT', `/reviews/${reviewId}/self`, { scores: scoreIds.map((id) => ({ id, rating: 4 })), summary: 'Good month', submit: true });
  check('employee hands in their self-assessment', r.data.status === 'manager_review', r.data.status);
  r = await staff('PUT', `/reviews/${reviewId}/manager`, { scores: [], submit: false });
  check('employee cannot write their own manager review', r.status === 403);

  const managerScores = [4, 3, 5, 4].map((rating, i) => ({ id: scoreIds[i], rating, comment: i === 1 ? 'Missed 2 targets' : '' }));
  r = await sup('PUT', `/reviews/${reviewId}/manager`, { scores: managerScores, summary: 'Solid', goals: 'Open 3 new stores', submit: false });
  check('manager saves a draft', r.status === 200 && r.data.status === 'manager_review');
  r = await staff('GET', `/reviews/${reviewId}`);
  check('employee cannot see the manager\'s draft', r.data.scores[1].manager_rating === null && r.data.manager_summary === null, r.data.scores[1]);
  r = await staff('GET', '/reviews?view=mine');
  check('review lists never include written drafts', r.data.length === 1 && !('manager_summary' in r.data[0]), r.data);
  r = await sup('PUT', `/reviews/${reviewId}/manager`, { scores: managerScores, summary: 'Solid', goals: 'Open 3 new stores', submit: true });
  // (4×30 + 3×30 + 5×20 + 4×20) ÷ 100 = 3.9
  check('manager submits: weighted score 3.90', r.data.status === 'acknowledgement' && Number(r.data.overall_score) === 3.9, r.data.overall_score);
  check('facts (attendance, leave & tasks) are frozen on the review', typeof r.data.facts?.workingDays === 'number' && r.data.facts.tasks && 'absentDays' in r.data.facts, r.data.facts);
  check('employee is emailed that the review is ready', /review is ready/.test(lastEmail(staffEmail)?.subject));
  r = await staff('POST', `/reviews/${reviewId}/acknowledge`, { comment: 'Agreed. Will improve on targets.' });
  check('employee confirms → completed', r.data.status === 'completed' && r.data.employee_comment.startsWith('Agreed'), r.data.status);
  r = await sup('POST', `/reviews/${reviewId}/cancel`);
  check('a completed review cannot be cancelled', r.status === 409);

  r = await sup('PUT', `/reviews/${supReviewId}/manager`, { scores: [], submit: false });
  check('nobody writes their own review', r.status === 403);
  r = await staff('GET', `/reviews/${supReviewId}`);
  check('staff cannot open their supervisor\'s review', r.status === 404);
  r = await owner('POST', `/reviews/${supReviewId}/cancel`);
  check('owner cancels a review', r.data.status === 'cancelled');
  r = await owner('POST', '/reviews/start', { period: thisMonth, employeeIds: [supId] });
  check('a cancelled review frees the month for a new one', r.data.created === 1, r.data);
  r = await hr('GET', `/reviews?period=${thisMonth}&status=completed`);
  check('HR sees completed reviews across the company', r.data.some((x) => x.id === reviewId), r.data.length);

  console.log('\nOnboarding');
  r = await hr('GET', '/onboarding/templates');
  check('two starter checklists (employee & manager)', r.data.length === 2 && r.data.some((t) => t.suits === 'managers') && r.data.every((t) => t.hr_items > 0 && t.joiner_items > 0), r.data);
  const employeeChecklist = r.data.find((t) => t.suits === 'staff');
  r = await staff('GET', '/onboarding/templates');
  check('staff cannot manage checklists', r.status === 403);
  r = await hr('POST', '/onboarding/templates', { name: 'Sales rep', suits: 'staff', items: [{ title: 'Shadow a senior rep', owner: 'new_joiner', dueDay: 2 }, { title: 'Order business cards', owner: 'hr', dueDay: 0 }] });
  check('HR creates a custom checklist', r.status === 201 && r.data.items.length === 2, r.data);
  r = await hr('GET', '/onboarding/candidates');
  const dayo = r.data.find((c) => c.id === otherId); // no team, no login
  const bola = r.data.find((c) => c.id === supId); // Team Supervisor
  const chidi = r.data.find((c) => c.id === staffId); // Employee role, but Dayo reports to him
  check('suggested checklist: staff vs manager (roles and direct reports)', dayo?.suits === 'staff' && !dayo.hasLogin && bola?.suits === 'managers' && chidi?.suits === 'managers', [dayo, bola, chidi]);

  const [obA, obB] = await Promise.all([
    hr('POST', '/onboarding', { employeeId: staffId, templateId: employeeChecklist.id, startDate: today }),
    hr('POST', '/onboarding', { employeeId: staffId, templateId: employeeChecklist.id, startDate: today }),
  ]);
  check('starting twice at once makes one onboarding', [obA.status, obB.status].sort().join() === '201,409', [obA.status, obB.status]);
  const onboarding = obA.status === 201 ? obA.data : obB.data;
  check('items copied with due dates from the start date', onboarding.items.length > 5 && onboarding.items.every((i) => i.due_date >= today), onboarding.items.length);
  check('new joiner is emailed their checklist', /onboarding checklist/.test(lastEmail(staffEmail)?.subject), lastEmail(staffEmail));

  r = await staff('GET', '/onboarding/mine');
  check('new joiner sees their onboarding', r.data?.id === onboarding.id && r.data.isJoiner && !r.data.canManage, r.data);
  const joinerItem = r.data.items.find((i) => i.owner === 'new_joiner');
  const hrItem = r.data.items.find((i) => i.owner === 'hr');
  r = await staff('PATCH', `/onboarding/items/${joinerItem.id}`, { done: true });
  check('new joiner ticks their own item', r.status === 200 && r.data.items.find((i) => i.id === joinerItem.id).done_at, r.data);
  r = await staff('PATCH', `/onboarding/items/${hrItem.id}`, { done: true });
  check('new joiner cannot tick HR items', r.status === 403);
  r = await sup('GET', `/onboarding/${onboarding.id}`);
  check('others cannot open someone\'s onboarding', r.status === 404);
  r = await hr('POST', `/onboarding/${onboarding.id}/items`, { title: 'Collect laptop from IT', owner: 'new_joiner', dueDate: today });
  check('HR adds an extra item for this person', r.status === 201 && r.data.items.some((i) => i.title === 'Collect laptop from IT'));
  for (const item of r.data.items.filter((i) => !i.done_at)) await hr('PATCH', `/onboarding/items/${item.id}`, { done: true });
  r = await hr('GET', `/onboarding/${onboarding.id}`);
  check('all ticked → onboarding completes by itself', r.data.status === 'completed' && Number(r.data.done_items) === Number(r.data.total_items), r.data.status);
  r = await staff('PATCH', `/onboarding/items/${joinerItem.id}`, { done: false });
  check('a finished onboarding is locked', r.status === 409);
  r = await hr('POST', '/onboarding', { employeeId: supId, templateId: employeeChecklist.id });
  r = await hr('POST', `/onboarding/${r.data.id}/cancel`);
  check('HR can cancel an onboarding', r.data.status === 'cancelled');

  console.log('\nPlans: Starter limits, upgrade, expiry & renewal');
  const small = client();
  const smallEmail = `small${stamp}@test.ng`;
  r = await small('POST', '/auth/register', { fullName: 'Kemi Small', organizationName: 'Kemi Bakery', email: smallEmail, password: 'secret123' });
  check('sign up needs a plan', r.status === 422 && r.data.errors?.plan, r.data);
  r = await small('POST', '/auth/register', { fullName: 'Kemi Small', organizationName: 'Kemi Bakery', email: smallEmail, password: 'secret123', plan: 'starter' });
  r = await small('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(smallEmail) });
  r = await small('POST', '/billing/checkout', { plan: 'starter' });
  check('Starter costs ₦250,000', r.data.amountKobo === 25_000_000, r.data);
  fakePaystack.state.transactions[r.data.reference].status = 'success';
  await small('POST', '/billing/verify', { reference: r.data.reference });
  r = await small('GET', '/tasks');
  check('Starter: tasks are locked (upgrade needed)', r.status === 403 && r.data.code === 'PLAN_UPGRADE_REQUIRED', r.data);
  check('Starter: payroll is locked', (await small('GET', '/payroll')).status === 403);
  check('Starter: onboarding is included', (await small('GET', '/onboarding/templates')).status === 200);
  r = await small('POST', '/organization/branches', { name: 'Second shop', clockInPolicy: 'none' });
  check('Starter: only one branch', r.status === 403 && r.data.code === 'PLAN_LIMIT', r.data);
  r = await small('POST', '/roles', { name: 'Baker', permissions: {} });
  check('Starter: no custom roles', r.status === 403 && r.data.code === 'PLAN_LIMIT', r.data);
  for (let i = 1; i <= 9; i += 1) await small('POST', '/employees', { firstName: `Staff${i}`, lastName: 'Test', email: `s${i}.${stamp}@test.ng` });
  r = await small('POST', '/employees', { firstName: 'Eleventh', lastName: 'Person', email: `s11.${stamp}@test.ng` });
  check('Starter: up to 10 active employees', r.status === 403 && /10 active employees/.test(r.data.message), r.data);
  r = await small('GET', '/dashboard');
  check('Starter dashboard has no money/customer/task blocks', r.status === 200 && r.data.money === null && r.data.customers === null && r.data.tasks === null, r.data);

  r = await small('GET', '/billing');
  const toBusiness = r.data.plans.find((p) => p.id === 'business').quote;
  check('upgrade price = the difference for the days left (₦350,000 for a full year)', toBusiness.kind === 'upgrade' && Math.abs(toBusiness.amountKobo - 35_000_000) <= 100_000, toBusiness);
  check('can\'t downgrade or renew early', r.data.plans.find((p) => p.id === 'starter').quote.allowed === false, r.data.plans);
  const endBefore = r.data.subscription.periodEnd;
  r = await small('POST', '/billing/checkout', { plan: 'business' });
  fakePaystack.state.transactions[r.data.reference].status = 'success';
  await small('POST', '/billing/verify', { reference: r.data.reference });
  r = await small('GET', '/auth/me');
  check('upgraded to Business, same end date', r.data.subscription.plan === 'business' && r.data.subscription.periodEnd === endBefore, r.data.subscription);
  check('Business: tasks now open', (await small('GET', '/tasks')).status === 200);
  check('Business: 11th employee now allowed', (await small('POST', '/employees', { firstName: 'Eleventh', lastName: 'Person', email: `s11.${stamp}@test.ng` })).status === 201);

  // The year runs out…
  const smallOrgId = r.data.organization.id;
  await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(CURDATE(), INTERVAL 3 DAY) WHERE organization_id = ?', [smallOrgId]);
  r = await small('GET', '/auth/me');
  check('3 days after the year ends: still works (grace) with a warning', r.data.subscription.status === 'grace' && (await small('GET', '/dashboard')).status === 200, r.data.subscription);
  await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(CURDATE(), INTERVAL 10 DAY) WHERE organization_id = ?', [smallOrgId]);
  check('10 days after: locked until renewed', (await small('GET', '/dashboard')).status === 402);
  r = await small('POST', '/billing/checkout', { plan: 'starter' });
  check('expired: can renew on any plan, full price', r.data.kind === 'renewal' && r.data.amountKobo === 25_000_000, r.data);
  fakePaystack.state.transactions[r.data.reference].status = 'success';
  // Owner closes the tab — Paystack's webhook confirms it instead
  const body = JSON.stringify({ event: 'charge.success', data: { reference: r.data.reference } });
  const sign = (key) => crypto.createHmac('sha512', key).update(body).digest('hex');
  let hook = await fetch(`${BASE}/webhooks/paystack-billing`, { method: 'POST', headers: { 'x-paystack-signature': sign('sk_test_forged'), 'Content-Type': 'application/json' }, body });
  check('billing webhook with a forged signature is rejected', hook.status === 401);
  hook = await fetch(`${BASE}/webhooks/paystack-billing`, { method: 'POST', headers: { 'x-paystack-signature': sign(BILLING_KEY), 'Content-Type': 'application/json' }, body });
  r = await small('GET', '/auth/me');
  check('webhook renews the plan (new year from today)', hook.status === 200 && r.data.subscription.status === 'active' && r.data.subscription.plan === 'starter' && r.data.subscription.daysLeft >= 364, r.data.subscription);
  r = await staff('POST', '/billing/checkout', { plan: 'business' });
  check('only the owner can pay', r.status === 403);

  // Organisations from before plans keep full access
  const legacy = client();
  const legacyEmail = `legacy${stamp}@test.ng`;
  r = await legacy('POST', '/auth/register', { fullName: 'Old Timer', organizationName: 'Old Co', email: legacyEmail, password: 'secret123', plan: 'starter' });
  r = await legacy('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(legacyEmail) });
  await pool.query('DELETE FROM subscriptions WHERE organization_id = ?', [r.data.organization.id]);
  r = await legacy('GET', '/auth/me');
  check('organisation from before plans: full access, no payment', r.data.subscription.isLegacy && r.data.subscription.status === 'active' && (await legacy('GET', '/payroll')).status === 200, r.data.subscription);

  console.log('\nDashboard & roles');
  r = await owner('GET', '/dashboard');
  check('owner dashboard counts all 6 employees', r.data.headcount === 6, r.data); // incl. HR & finance added for payroll
  r = await sup('GET', '/dashboard');
  check('supervisor dashboard counts their team (2)', r.data.headcount === 2, r.data);
  r = await staff('GET', '/dashboard');
  check('employee has no business dashboard', r.status === 403);

  r = await owner('POST', '/roles', { name: 'Branch Accountant', permissions: { 'employees.view': 'branch', 'roles.manage': 'own' } });
  check('create custom role (scopes cleaned)', r.status === 201 && r.data.permissions['roles.manage'] === 'all', r.data);
  r = await owner('PATCH', `/employees/${staffId}/role`, { roleId: r.data.id });
  check('assign custom role', r.status === 200, r.data);
  r = await staff('GET', '/employees');
  // Wuse branch has 5 people (the owner is in Head Office)
  check('role change applies immediately (branch scope)', r.status === 200 && r.data.total === 5, r.data);

  r = await owner('POST', `/employees/${staffId}/exit`, {});
  check('exit employee', r.status === 200 && r.data.status === 'exited', r.data);
  r = await staff('GET', '/auth/me');
  check('exited employee loses access', r.status === 401, r.data);

  console.log('\nForgot password');
  r = await anon('POST', '/auth/forgot-password', { email: `nobody${stamp}@test.ng` });
  check('unknown email gets the same answer', r.status === 200 && r.data.challengeToken);
  r = await anon('POST', '/auth/forgot-password', { email: ownerEmail });
  r = await anon('POST', '/auth/reset-password', { challengeToken: r.data.challengeToken, code: codeFor(ownerEmail), password: 'newpass123' });
  check('reset password with emailed code', r.status === 200, r.data);
  r = await owner2('POST', '/auth/refresh');
  check('reset logs out other sessions', r.status === 401);
  r = await anon('POST', '/auth/login', { email: ownerEmail, password: 'newpass123' });
  check('can log in with the new password', r.data.requiresOtp === true, r.data);

  r = await owner('GET', '/organization/audit-logs');
  check('activity log recorded actions', Array.isArray(r.data) && r.data.length > 5, r.data);
} catch (err) {
  failed += 1;
  console.error('\n✖ Test crashed:', err);
} finally {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  fakePaystack.server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
}
