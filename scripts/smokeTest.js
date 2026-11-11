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
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'APItestkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// Mail: fake Google + Microsoft (OAuth and mail APIs), so connecting/sending/inbox need no real accounts
const { startFakeMail } = await import('./fakeMailProviders.js');
const fakeMail = startFakeMail();
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  MICROSOFT_CLIENT_ID: 'test-ms-client',
  MICROSOFT_CLIENT_SECRET: 'test-ms-secret',
  MAIL_CALLBACK_BASE: 'http://callback.test',
  MAIL_GOOGLE_INBOX: 'workspace',
  MAIL_GOOGLE_AUTH_BASE: fakeMail.url,
  MAIL_GOOGLE_TOKEN_BASE: fakeMail.url,
  MAIL_GOOGLE_API_BASE: fakeMail.url,
  MAIL_MICROSOFT_AUTH_BASE: fakeMail.url,
  MAIL_MICROSOFT_API_BASE: fakeMail.url,
});

const { default: app } = await import('../src/app.js');
const { devOutbox } = await import('../src/services/emailService.js');
const { pool } = await import('../src/config/db.js');
const { billing } = await import('../src/config/plans.js');
const addDaysIso = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
billing.enabled = true; // test the paid flow (switched off further down to test free early access)
billing.trialDays = 14;
billing.startDate = null;
await pool.query('DELETE FROM billing_plan_codes'); // plan codes belong to the fake Paystack, which starts empty each run

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
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
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
  check('new organisation starts a 14-day free trial of its plan', r.data.subscription?.status === 'trial' && r.data.subscription.plan === 'enterprise' && r.data.subscription.daysLeft === 13 && r.data.subscription.usable, r.data.subscription);
  check('the app works during the trial', (await owner('GET', '/dashboard')).status === 200);

  console.log('\nPaying for the plan (fake Paystack)');
  const [[ownerOrg]] = await pool.query('SELECT organization_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [ownerEmail]);
  await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE organization_id = ?', [ownerOrg.organization_id]);
  r = await owner('GET', '/dashboard');
  check('when the trial ends the app locks until the plan is paid (402)', r.status === 402 && r.data.code === 'SUBSCRIPTION_REQUIRED' && /free trial has ended/.test(r.data.message), r.data);
  r = await owner('GET', '/billing');
  const ent = r.data.plans?.[2];
  check('billing page still works while locked: Enterprise ₦55,000/month or ₦647,988/year', r.status === 200 && ent.quotes.monthly.amountKobo === 5_500_000 && ent.quotes.yearly.amountKobo === 64_798_800 && ent.prices.yearlyPerMonth === 5_399_900, ent);
  r = await owner('POST', '/billing/checkout', { plan: 'enterprise', interval: 'yearly' });
  check('checkout returns a Paystack payment page for ₦647,988 (yearly)', r.status === 201 && r.data.authorizationUrl && r.data.amountKobo === 64_798_800 && r.data.kind === 'new', r.data);
  const firstRef = r.data.reference;
  r = await owner('POST', '/billing/verify', { reference: firstRef });
  check('not paid yet → still locked', r.data.status !== 'paid' && (await owner('GET', '/dashboard')).status === 402, r.data);
  fakePaystack.pay(firstRef); // the owner pays on Paystack
  const [verifyA, verifyB] = await Promise.all([
    owner('POST', '/billing/verify', { reference: firstRef }),
    owner('POST', '/billing/verify', { reference: firstRef }),
  ]);
  check('payment confirmed with Paystack (twice at once is fine)', verifyA.data.status === 'paid' && verifyB.data.status === 'paid', [verifyA.data, verifyB.data]);
  const [[paidRows]] = await pool.query("SELECT COUNT(*) AS n FROM billing_payments WHERE reference = ? AND status = 'paid'", [firstRef]);
  check('…and applied exactly once', Number(paidRows.n) === 1);
  r = await owner('GET', '/auth/me');
  check('plan is active for a year', r.data.subscription?.status === 'active' && r.data.subscription.daysLeft >= 364, r.data.subscription);
  r = await owner('GET', '/billing');
  check('…and renews automatically (Paystack subscription saved)', r.data.subscription.autoRenew === true && r.data.subscription.interval === 'yearly' && r.data.subscription.canManageCard, r.data.subscription);
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

  r = await staff('GET', '/me/attendance/today');
  check('today’s card lists the clock-in to explain', r.data.toExplain?.length === 1 && !!r.data.toExplain[0].explain_deadline, r.data.toExplain);
  check('employee is emailed to explain within 24 hours', /explain within 24 hours/.test(lastEmail(staffEmail)?.subject), lastEmail(staffEmail));

  r = await sup('GET', '/attendance/flagged');
  const flaggedRecord = r.data.find?.((a) => a.employee_id === staffId);
  check('supervisor sees the flagged clock-in, waiting for the employee', flaggedRecord?.stage === 'waiting' && !!flaggedRecord.explain_deadline, flaggedRecord);
  r = await staff('PATCH', `/attendance/${flaggedRecord.id}/review`, { decision: 'approved' });
  check('employee cannot review clock-ins', r.status === 403);
  r = await sup('PATCH', `/attendance/${flaggedRecord.id}/review`, { decision: 'approved' });
  check('managers wait for the employee’s side first', r.status === 409 && /has until/.test(r.data.message), r.data);

  r = await staff('POST', `/me/attendance/${flaggedRecord.id}/explanation`, { response: 'maybe', reason: 'x' });
  check('explanation needs accept/dispute and a reason', r.status === 422, r.data);
  r = await sup('POST', `/me/attendance/${flaggedRecord.id}/explanation`, { response: 'accept', reason: 'Not mine to explain' });
  check('nobody else can explain your clock-in', r.status === 404, r.data);
  r = await staff('POST', `/me/attendance/${flaggedRecord.id}/explanation`, { response: 'dispute', reason: 'I was at the Wuse client site all morning' });
  check('employee disputes with a reason', r.status === 200 && r.data.explanation_response === 'dispute' && /Wuse/.test(r.data.explanation_reason), r.data);
  r = await staff('POST', `/me/attendance/${flaggedRecord.id}/explanation`, { response: 'accept', reason: 'Changed my mind' });
  check('only one explanation per clock-in', r.status === 409, r.data);
  check('supervisor is emailed the explanation', /Flagged clock-in to review: Chidi Eze/.test(lastEmail(supEmail)?.subject) && /Wuse/.test(lastEmail(supEmail)?.text), lastEmail(supEmail));
  check('owner is emailed too (scope covers everyone)', /Flagged clock-in to review/.test(lastEmail(ownerEmail)?.subject), lastEmail(ownerEmail));
  r = await staff('GET', '/me/attendance/today');
  check('employee sees their explanation on today’s card', r.data.record?.explanation_response === 'dispute' && r.data.toExplain.length === 0, r.data);

  r = await sup('GET', '/attendance/flagged');
  const ready = r.data.find?.((a) => a.id === flaggedRecord.id);
  check('now ready for a decision, with the reason beside it', ready?.stage === 'ready' && /Wuse/.test(ready.explanation_reason), ready);
  r = await sup('PATCH', `/attendance/${flaggedRecord.id}/review`, { decision: 'approved', note: 'Was at a client site' });
  check('supervisor approves it', r.status === 200 && r.data.review_status === 'approved', r.data);
  check('employee is emailed the decision', /was accepted/.test(lastEmail(staffEmail)?.subject), lastEmail(staffEmail));
  r = await staff('GET', '/notifications');
  check('…and gets bell notifications for the flag and the decision', r.data.items.some((n) => n.type === 'attendance.flagged') && r.data.items.some((n) => n.type === 'attendance.approved'), r.data.items.map((n) => n.type));
  r = await sup('GET', '/notifications');
  check('the supervisor’s bell shows the explanation to review', r.data.items.some((n) => n.type === 'attendance.to_review' && /Wuse/.test(n.body)), r.data.items.map((n) => n.type));

  // A supervisor's own flag is never in their review list
  r = await sup('POST', '/me/attendance/clock-in', { latitude: 9.2, longitude: 7.6, accuracy: 20 });
  check('supervisor’s own clock-in is flagged', r.data.record?.is_flagged === 1 && r.data.record?.review_status === 'pending', r.data.record);
  const supFlagId = r.data.record.id;
  r = await sup('GET', '/attendance/flagged');
  check('your own flags are not in your review list', !r.data.some((a) => a.id === supFlagId), r.data);
  r = await owner('GET', '/attendance/flagged');
  check('the owner sees the supervisor’s flag', r.data.some((a) => a.id === supFlagId), r.data);

  // The owner has nobody above them: their flag is accepted straight away
  const [[ownerEmp]] = await pool.query('SELECT id, branch_id FROM employees WHERE email = ?', [ownerEmail]);
  await owner('PATCH', `/employees/${ownerEmp.id}`, { branchId });
  r = await owner('POST', '/me/attendance/clock-in', { latitude: 9.2, longitude: 7.6, accuracy: 20 });
  check('owner’s flagged clock-in needs no review', r.data.record?.is_flagged === 1 && r.data.record?.review_status === 'approved', r.data.record);
  const ownerFlagId = r.data.record?.id;
  r = await owner('GET', '/attendance/flagged');
  check('owner’s own flag is not waiting anywhere', !r.data.some((a) => a.id === ownerFlagId), r.data);
  await pool.query('UPDATE employees SET branch_id = ? WHERE id = ?', [ownerEmp.branch_id, ownerEmp.id]);

  // Nobody answers within 24 hours → managers get it as "no response"
  await pool.query("UPDATE attendance SET clock_in_at = clock_in_at - INTERVAL 25 HOUR WHERE id = ?", [supFlagId]);
  r = await sup('POST', `/me/attendance/${supFlagId}/explanation`, { response: 'accept', reason: 'Too late now' });
  check('after 24 hours the employee can no longer explain', r.status === 409 && /hours to explain have passed/.test(r.data.message), r.data);
  r = await owner('GET', '/attendance/flagged');
  check('after 24 hours it is ready for the owner', r.data.find((a) => a.id === supFlagId)?.stage === 'ready', r.data);
  const { escalateUnansweredFlags } = await import('../src/services/attendanceService.js');
  const escalated = await escalateUnansweredFlags();
  check('the daily job sends unanswered flags on as “no response”', escalated >= 1, escalated);
  check('owner is told the supervisor did not respond', /did not respond within 24 hours/.test(lastEmail(ownerEmail)?.text) && /Bola Ade/.test(lastEmail(ownerEmail)?.subject), lastEmail(ownerEmail));
  check('…and only once', (await escalateUnansweredFlags()) === 0);
  r = await owner('PATCH', `/attendance/${supFlagId}/review`, { decision: 'rejected', note: 'No reason given' });
  check('owner rejects it', r.status === 200 && r.data.review_status === 'rejected', r.data);

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

  console.log('\nInvoice branding & customer acceptance');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await owner('PUT', '/invoices/branding', { brandColor: 'blue', signatoryName: 'Ada Okafor' });
  check('brand colour must be a hex colour', r.status === 422, r.data);
  r = await owner('PUT', '/invoices/branding', { brandColor: '#7c3aed', signatoryName: 'Ada Okafor', signatoryTitle: 'Managing Director' });
  check('save brand colour and signatory', r.status === 200 && r.data.brandColor === '#7c3aed' && r.data.signatoryTitle === 'Managing Director', r.data);
  const logoForm = new FormData();
  logoForm.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'logo.png');
  r = await owner('POST', '/invoices/branding/logo', logoForm);
  check('upload a logo (kept in the database without Cloudinary in development)', r.status === 200 && r.data.logoUrl?.startsWith('data:image/png;base64,'), r.data);
  const sigForm = new FormData();
  sigForm.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'signature.png');
  r = await owner('POST', '/invoices/branding/signature', sigForm);
  check('add the business signature', r.status === 200 && !!r.data.signatureUrl, r.data);
  r = await staff('PUT', '/invoices/branding', { brandColor: '#000000' });
  check('only finance managers change branding', r.status === 403, r.data);
  r = await anon('GET', `/public/invoices/${token}`);
  check('the public invoice shows the logo, colour and signature', r.data.business?.logoUrl && r.data.business.brandColor === '#7c3aed' && r.data.business.signatoryName === 'Ada Okafor' && r.data.acceptance === null, r.data.business);

  r = await anon('POST', `/public/invoices/${token}/accept`, { name: 'Zainab Bello', signature: 'not-a-picture' });
  check('acceptance needs a drawn signature', r.status === 422 && r.data.errors?.signature, r.data);
  r = await anon('POST', `/public/invoices/${token}/accept`, { name: 'Zainab Bello', signature: `data:image/png;base64,${PNG}`, note: 'Please deliver before Friday' });
  check('customer accepts and signs with a note', r.status === 201 && r.data.name === 'Zainab Bello' && r.data.note === 'Please deliver before Friday', r.data);
  r = await anon('POST', `/public/invoices/${token}/accept`, { name: 'Someone Else', signature: `data:image/png;base64,${PNG}` });
  check('an invoice is accepted only once', r.status === 409, r.data);
  check('whoever sent the invoice is emailed', /Zenith Foods Ltd accepted invoice INV-0001/.test(lastEmail(ownerEmail)?.subject) && /before Friday/.test(lastEmail(ownerEmail)?.text), lastEmail(ownerEmail));
  r = await owner('GET', `/invoices/${inv1}`);
  check('the invoice in the app shows the acceptance', r.data.acceptance?.name === 'Zainab Bello' && r.data.acceptance.signature.startsWith('data:image/png') && r.data.business.brandColor === '#7c3aed', r.data.acceptance);
  r = await owner('DELETE', '/invoices/branding/logo');
  check('remove the logo', r.status === 200 && r.data.logoUrl === null, r.data);
  r = await owner('GET', `/invoices/${inv1}`);
  check('invoice shows as viewed and customer promoted', r.data.viewed_at && r.data.status === 'sent', r.data);
  r = await owner('GET', `/customers/${custA}`);
  check('lead became a customer when invoiced', r.data.stage === 'customer', r.data.stage);

  console.log('\nAssigned leads & the notification bell');
  r = await owner('POST', '/customers', { name: 'Bell Test Ltd', stage: 'lead', assignedEmployeeId: staffId });
  const bellCust = r.data.id;
  check('owner assigns a lead; it remembers who assigned it', r.data.assigned_by_name === 'Ada Okafor' && !!r.data.assigned_at, r.data);
  r = await staff('GET', '/notifications/count');
  check('the employee gets a bell notification', r.data.unread >= 1, r.data);
  r = await staff('GET', '/notifications');
  const assignedNote = r.data.items.find((n) => n.type === 'customer.assigned');
  check('…saying who assigned what, linking to the customer', /Ada Okafor assigned you a lead: Bell Test Ltd/.test(assignedNote?.title) && assignedNote.link === `/customers/${bellCust}` && assignedNote.actor_name === 'Ada Okafor', assignedNote);
  r = await staff('GET', '/customers/assigned-to-me');
  check('dashboard “Assigned to you” shows who assigned it', r.data.some((c) => c.id === bellCust && c.assigned_by_name === 'Ada Okafor'), r.data);
  r = await staff('PATCH', `/customers/${bellCust}`, { stage: 'customer' });
  check('the employee can move their assigned lead to customer', r.status === 200 && r.data.stage === 'customer', r.data);
  r = await staff('POST', `/customers/${bellCust}/activity`, { type: 'call', subject: 'Agreed delivery dates' });
  r = await owner('GET', '/notifications');
  check('whoever assigned it is told about the stage change', r.data.items.some((n) => n.type === 'customer.updated' && /moved Bell Test Ltd from Lead to Customer/.test(n.title)), r.data.items.slice(0, 3));
  check('…and about logged activity', r.data.items.some((n) => /logged a call on Bell Test Ltd: Agreed delivery dates/.test(n.title)), r.data.items.slice(0, 3));
  r = await owner('GET', '/notifications');
  const firstNote = r.data.items[0];
  r = await owner('PATCH', `/notifications/${firstNote.id}/read`);
  check('mark one notification read', r.status === 200 && typeof r.data.unread === 'number');
  r = await staff('PATCH', `/notifications/${firstNote.id}/read`);
  r = await owner('GET', '/notifications');
  check('you can only read your own notifications', r.data.items.find((n) => n.id === firstNote.id)?.read_at && !r.data.items.some((n) => n.type === 'customer.assigned' && /assigned you/.test(n.title)), r.data.items.slice(0, 2));
  r = await owner('POST', '/notifications/read-all');
  check('mark all read', (await owner('GET', '/notifications/count')).data.unread === 0);
  r = await owner('PATCH', `/customers/${bellCust}`, { stage: 'customer', notes: 'VIP' });
  check('your own changes don’t notify you', (await owner('GET', '/notifications/count')).data.unread === 0);
  await pool.query('DELETE FROM customers WHERE id = ?', [bellCust]); // keep the sales numbers below as they were

  console.log('\nSales pipeline (stages, lost deals, conversion)');
  r = await owner('POST', '/customers', { name: 'Lost Deal Ltd', stage: 'prospect', source: 'Referral' });
  const lostId = r.data.id;
  r = await owner('PATCH', `/customers/${lostId}`, { stage: 'lost' });
  check('a deal can be marked lost', r.status === 200 && r.data.stage === 'lost', r.data);
  await owner('PATCH', `/customers/${lostId}`, { stage: 'lost', notes: 'Went with a competitor' });
  r = await owner('GET', `/customers/${custA}/stages`);
  check('stage history is kept (lead → customer when invoiced)', r.data.length === 2 && r.data[0].to_stage === 'lead' && r.data[1].from_stage === 'lead' && r.data[1].to_stage === 'customer', r.data);
  r = await owner('GET', `/customers/${lostId}/stages`);
  check('saving without changing the stage adds no history', r.data.length === 2, r.data);
  r = await staff('GET', `/customers/${custC}/stages`);
  check('stage history follows the customer scope', r.status === 404, r.data);

  r = await owner('GET', '/customers');
  check('list comes with a count per stage', r.data.stageCounts?.customer === 1 && r.data.stageCounts?.lost === 1 && r.data.stageCounts?.lead === 3, r.data.stageCounts);
  r = await staff('GET', '/customers');
  check('stage counts follow the scope', r.data.stageCounts?.customer === 1 && r.data.stageCounts?.lead === 1 && !r.data.stageCounts?.lost, r.data.stageCounts);

  r = await owner('GET', '/customers/sales?months=6');
  const s = r.data;
  check('sales funnel: 5 leads → 2 prospects → 1 customer, 1 lost', s.funnel?.leads === 5 && s.funnel.prospects === 2 && s.funnel.customers === 1 && s.funnel.lost === 1 && s.funnel.open === 3, s.funnel);
  check('win rate = won ÷ (won + lost) = 50%; lead → customer 20%', s.winRate === 50 && s.conversion === 20 && s.totals.won === 1 && s.totals.lost === 1, s);
  check('six months, this month has the activity', s.months?.length === 6 && s.months.at(-1).newLeads === 5 && s.months.at(-1).won === 1, s.months);
  check('conversion by lead source', s.sources?.find((x) => x.source === 'Referral')?.lost === 1 && s.sources.find((x) => x.source === 'Not recorded')?.customers === 1, s.sources);
  r = await staff('GET', '/customers/sales');
  check('sales numbers follow the scope (staff sees their own pipeline)', r.status === 200 && r.data.funnel.leads === 2 && r.data.funnel.customers === 1, r.data.funnel);

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

  r = await hr('POST', '/payroll', { period: '2027-05', copyFrom: run1 });
  const copiedItem = r.data.items?.find((i) => i.employee_id === staffId);
  check('copy a payroll into a new month: same people, bonus carried over', r.status === 201 && r.data.items.length === 2 && Number(copiedItem?.bonus_kobo) === 5000000, r.data);
  await hr('POST', `/payroll/${r.data.id}/cancel`);
  r = await hr('POST', '/payroll', { period: '2027-05' });
  check('…without "copy", bonuses start at zero', r.status === 201 && r.data.items.every((i) => Number(i.bonus_kobo) === 0), r.data.items?.map((i) => i.bonus_kobo));
  const plainRun = r.data.id;
  r = await hr('POST', '/payroll', { period: '2027-06', copyFrom: (raceA.status === 201 ? raceA : raceB).data.id });
  check('can’t copy from a cancelled payroll', r.status === 422, r.data);
  r = await hr('POST', '/payroll', { period: '2027-05', copyFrom: run1 });
  check('copying into a month that already has a payroll is refused', r.status === 409, r.data);
  await hr('POST', `/payroll/${plainRun}/cancel`);

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

  console.log('\nSalary advances & staff loans (through payroll)');
  await owner('PATCH', `/employees/${staffId}`, { managerId: supId }); // Chidi reports to Bola
  r = await staff('GET', '/requests/limits');
  check('limits: advance up to one month’s basic (₦300,000), loan up to a year’s basic (₦3.6m)', r.data.advance.maxKobo === 30_000_000 && r.data.loan.maxKobo === 360_000_000, r.data);
  r = await staff('POST', '/requests', { type: 'loan', amount: 4_000_000, reason: 'Rent for the new flat' });
  check('a loan over a year’s basic pay is refused', r.status === 422 && r.data.errors?.amount, r.data);
  r = await staff('POST', '/requests', { type: 'loan', amount: 1_200_000, reason: 'Rent for the new flat' });
  check('loan of ₦1.2m: 5% flat → repay ₦1,260,000 at ₦105,000 a month for 12 months', r.status === 201 && r.data.total_repayable_kobo === 126_000_000 && r.data.monthly_deduction_kobo === 10_500_000 && r.data.months === 12, r.data);
  const loanId = r.data.id;
  r = await sup('GET', '/notifications');
  check('the line manager is told', r.data.items.some((n) => n.type === 'request.new' && /staff loan of ₦1,200,000/.test(n.title)), r.data.items.map((n) => n.title));
  r = await sup('GET', '/requests?view=approvals');
  check('…and sees it to approve', r.data.some((x) => x.id === loanId && x.canDecide), r.data);
  r = await hr('PATCH', `/requests/${loanId}/decision`, { decision: 'approved' });
  check('with a line manager set, HR can’t approve it instead', r.status === 403, r.data);
  r = await staff('PATCH', `/requests/${loanId}/decision`, { decision: 'approved' });
  check('nobody approves their own request', r.status === 403);
  r = await sup('PATCH', `/requests/${loanId}/decision`, { decision: 'approved', note: 'Approved — good luck with the move' });
  check('line manager approves', r.status === 200 && r.data.status === 'approved', r.data);
  r = await staff('GET', '/notifications');
  check('employee is told it was approved', r.data.items.some((n) => n.type === 'request.approved'), r.data.items.map((n) => n.type));
  r = await hr('GET', '/notifications');
  check('the payroll team is told to pay it out', r.data.items.some((n) => n.type === 'request.to_pay'), r.data.items.map((n) => n.type));
  r = await staff('POST', `/requests/${loanId}/paid-out`);
  check('only the payroll team marks it paid out', r.status === 403);
  r = await hr('POST', `/requests/${loanId}/paid-out`);
  check('payroll marks the loan paid out', r.status === 200 && r.data.status === 'paid_out', r.data);

  r = await staff('POST', '/requests', { type: 'advance', amount: 100_000, reason: 'School fees this week' });
  check('salary advance of ₦100,000 (no interest)', r.status === 201 && r.data.total_repayable_kobo === 10_000_000 && r.data.months === 1, r.data);
  const advanceId = r.data.id;
  r = await staff('POST', '/requests', { type: 'advance', amount: 50_000, reason: 'Another one please' });
  check('only one salary advance open at a time', r.status === 409, r.data);
  await sup('PATCH', `/requests/${advanceId}/decision`, { decision: 'approved' });
  await hr('POST', `/requests/${advanceId}/paid-out`);

  r = await hr('POST', '/payroll', { period: '2026-02' });
  const loanRun = r.data.id;
  const chidiItem = r.data.items?.find((i) => i.employee_id === staffId);
  const lines = JSON.parse(chidiItem?.breakdown || '[]');
  check('next payroll deducts ₦105,000 loan + ₦100,000 advance', Number(chidiItem?.other_deductions_kobo) === 20_500_000 && lines.length === 2, [chidiItem?.other_deductions_kobo, lines]);
  check('net pay drops by exactly ₦205,000', Number(chidiItem?.net_kobo) === 39_830_000 - 20_500_000, chidiItem?.net_kobo);
  await owner('POST', `/payroll/${loanRun}/approve`);
  await fin('POST', `/payroll/${loanRun}/mark-paid`, { paidOn: today, method: 'bank_upload' });
  r = await staff('GET', `/requests/${loanId}`);
  check('after payroll is paid: loan balance ₦1,155,000, one repayment', r.data.balance_kobo === 115_500_000 && r.data.repayments.length === 1 && r.data.status === 'paid_out', r.data);
  r = await staff('GET', `/requests/${advanceId}`);
  check('the advance is fully repaid', r.data.status === 'repaid' && r.data.balance_kobo === 0, r.data);
  const { recordRepaymentsForRun } = await import('../src/services/staffRequestService.js');
  check('a payroll’s repayments are never counted twice', (await recordRepaymentsForRun(orgId, loanRun)) === 0);
  r = await staff('GET', '/requests/limits');
  check('open loans count towards the limit (₦3.6m − ₦1.2m)', r.data.loan.maxKobo === 240_000_000 && r.data.advance.maxKobo === 30_000_000, r.data);
  r = await staff('POST', '/requests', { type: 'advance', amount: 20_000, reason: 'Transport' });
  const cancelId = r.data.id;
  r = await staff('POST', `/requests/${cancelId}/cancel`);
  check('employee can cancel a request that’s still pending', r.data.status === 'cancelled', r.data);
  r = await sup('GET', `/requests/${loanId}`);
  check('the line manager can open it', r.status === 200);

  // Each company sets its own loan & advance rules (Settings → Loans & advances)
  r = await staff('GET', '/requests/settings');
  check('every company starts on the defaults: 100% of yearly basic, 12 months, 5%', r.data.isDefault && r.data.loanMaxPercent === 100 && r.data.loanMonths === 12 && r.data.loanInterestBp === 500 && r.data.advanceMaxPercent === 100, r.data);
  const newRules = { loansEnabled: true, loanMaxPercent: 50, loanMaxNaira: 1_500_000, loanMonths: 6, loanInterestPercent: 2.5, advancesEnabled: true, advanceMaxPercent: 50, advanceMonths: 2, advanceInterestPercent: 0 };
  r = await staff('PUT', '/requests/settings', newRules);
  check('employees can’t change the rules', r.status === 403);
  r = await hr('PUT', '/requests/settings', { ...newRules, loanMonths: 0, loanInterestPercent: -1 });
  check('bad months / interest are refused', r.status === 422 && r.data.errors?.loanMonths && r.data.errors?.loanInterestPercent, r.data.errors);
  r = await hr('PUT', '/requests/settings', newRules);
  check('the payroll team sets: 50% of yearly basic, max ₦1.5m, 6 months, 2.5%', r.status === 200 && !r.data.isDefault && r.data.loanMaxKobo === 150_000_000 && r.data.loanInterestBp === 250, r.data);
  r = await staff('GET', '/requests/limits');
  // 50% of ₦3.6m = ₦1.8m, but the ceiling is ₦1.5m; minus the ₦1.2m loan already open = ₦300,000
  check('limits follow the company’s rules (ceiling, open loans)', r.data.loan.maxKobo === 30_000_000 && r.data.loan.months === 6 && r.data.advance.maxKobo === 15_000_000 && r.data.advance.months === 2, r.data);
  r = await staff('POST', '/requests', { type: 'loan', amount: 300_001, reason: 'Too much' });
  check('…and are enforced', r.status === 422, r.data);
  r = await staff('POST', '/requests', { type: 'loan', amount: 200_000, reason: 'Car repair' });
  check('a new loan uses the new terms (6 months, 2.5%: ₦205,000)', r.status === 201 && r.data.months === 6 && r.data.interest_rate_bp === 250 && r.data.total_repayable_kobo === 20_500_000, r.data);
  await staff('POST', `/requests/${r.data.id}/cancel`);
  r = await staff('GET', `/requests/${loanId}`);
  check('loans already taken keep their old terms', r.data.months === 12 && r.data.interest_rate_bp === 500, r.data);
  r = await hr('PUT', '/requests/settings', { ...newRules, loansEnabled: false });
  r = await staff('POST', '/requests', { type: 'loan', amount: 10_000, reason: 'School fees' });
  check('a company can switch staff loans off', r.status === 403 && /doesn’t offer staff loans/.test(r.data.message), r.data);
  r = await hr('DELETE', '/requests/settings');
  check('back to the defaults', r.data.isDefault && r.data.loanMonths === 12 && r.data.loansEnabled, r.data);
  r = await hr('GET', '/organization/audit-logs');
  check('rule changes are in the activity log', r.status !== 200 || r.data.some((l) => l.action === 'requests.settings_updated'), r.data?.slice?.(0, 2));

  console.log('\nFeedback, complaints & suggestions');
  r = await staff('POST', '/requests/feedback', { category: 'suggestion', subject: 'Water dispenser', body: 'Could we get a water dispenser on the 2nd floor?', isAnonymous: false });
  check('send a named suggestion', r.status === 201 && r.data.sender_name === 'Chidi Eze' && r.data.privateLink === null, r.data);
  const namedFb = r.data.id;
  r = await staff('POST', '/requests/feedback', { category: 'complaint', subject: 'Unfair shift rota', body: 'The weekend shifts always go to the same three people.', isAnonymous: true });
  check('send an anonymous complaint → private link to follow it', r.status === 201 && r.data.sender_name === null && /^\/feedback\/[a-f0-9]{48}$/.test(r.data.privateLink), r.data);
  const anonToken = r.data.privateLink.split('/').pop();
  const anonId = r.data.id;
  const [[anonRow]] = await pool.query('SELECT employee_id, user_id, token_hash FROM staff_feedback WHERE id = ?', [anonId]);
  check('anonymous: no employee or user is stored, only a hash of the link', anonRow.employee_id === null && anonRow.user_id === null && anonRow.token_hash.length === 64 && !anonRow.token_hash.includes(anonToken), anonRow);
  r = await hr('GET', '/notifications');
  check('HR is told, without a name', r.data.items.some((n) => n.type === 'feedback.new' && /^Someone \(anonymous\)/.test(n.title) && n.actor_name === null), r.data.items.filter((n) => n.type === 'feedback.new'));
  r = await hr('GET', '/requests/feedback/inbox');
  check('HR sees both in the inbox', r.data.some((f) => f.id === anonId && f.sender_name === null && f.is_anonymous === 1) && r.data.some((f) => f.id === namedFb), r.data);
  r = await staff('GET', '/requests/feedback/inbox');
  check('staff can’t read the inbox', r.status === 403);
  r = await staff('GET', '/requests/feedback/mine');
  check('“my feedback” lists the named one only (anonymous isn’t linked to you)', r.data.length === 1 && r.data[0].id === namedFb, r.data);
  r = await hr('POST', `/requests/feedback/${anonId}/replies`, { body: 'Thanks — we’ll rotate weekends from next month.', status: 'in_review' });
  check('HR replies to the anonymous complaint', r.status === 200 && r.data.replies.length === 1 && r.data.status === 'in_review', r.data);
  r = await staff('GET', `/requests/feedback/private/${anonToken}`);
  check('the sender reads the reply through their private link', r.status === 200 && r.data.replies[0].author_name === 'Hauwa HR', r.data);
  r = await staff('POST', `/requests/feedback/private/${anonToken}/replies`, { body: 'Thank you!' });
  check('…and answers, still anonymous', r.data.replies.at(-1).from_sender === 1 && r.data.replies.at(-1).author_name === null, r.data.replies);
  r = await staff('GET', `/requests/feedback/private/${'0'.repeat(48)}`);
  check('a wrong link finds nothing', r.status === 404);
  r = await hr('POST', `/requests/feedback/${namedFb}/replies`, { body: 'Ordered one!', status: 'resolved' });
  r = await staff('GET', '/notifications');
  check('a named sender is told about the reply', r.data.items.some((n) => n.type === 'feedback.reply'), r.data.items.map((n) => n.type));
  const [[auditAnon]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE details LIKE '%Unfair shift rota%'");
  check('anonymous feedback leaves nothing in the activity log', Number(auditAnon.n) === 0);

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
  r = await small('POST', '/billing/checkout', { plan: 'starter', interval: 'monthly' });
  check('Starter costs ₦15,000 a month', r.data.amountKobo === 1_500_000, r.data);
  fakePaystack.pay(r.data.reference);
  await small('POST', '/billing/verify', { reference: r.data.reference });
  r = await small('GET', '/billing');
  check('paid monthly: about a month, renews automatically', r.data.subscription.interval === 'monthly' && r.data.subscription.daysLeft >= 27 && r.data.subscription.daysLeft <= 31 && r.data.subscription.autoRenew, r.data.subscription);
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
  const toBusiness = r.data.plans.find((p) => p.id === 'business').quotes;
  check('upgrade price = the difference for the days left (about ₦20,000 for a whole month)', toBusiness.monthly.kind === 'upgrade' && toBusiness.monthly.amountKobo <= 2_000_000 && toBusiness.monthly.amountKobo >= 1_800_000, toBusiness.monthly);
  check('switching to yearly waits for the next period (no payment now)', toBusiness.yearly.kind === 'scheduled' && toBusiness.yearly.amountKobo === 0, toBusiness.yearly);
  check('the current plan shows when it renews', r.data.plans.find((p) => p.id === 'starter').quotes.monthly.current === true, r.data.plans[0].quotes);
  const endBefore = r.data.subscription.periodEnd;
  const [[smallSubBefore]] = await pool.query('SELECT s.* FROM subscriptions s JOIN memberships m ON m.organization_id = s.organization_id JOIN users u ON u.id = m.user_id WHERE u.email = ?', [smallEmail]);
  r = await small('POST', '/billing/checkout', { plan: 'business', interval: 'monthly' });
  fakePaystack.pay(r.data.reference);
  await small('POST', '/billing/verify', { reference: r.data.reference });
  r = await small('GET', '/auth/me');
  check('upgraded to Business, same end date', r.data.subscription.plan === 'business' && r.data.subscription.periodEnd === endBefore, r.data.subscription);
  const [[smallSub]] = await pool.query('SELECT * FROM subscriptions WHERE organization_id = ?', [smallSubBefore.organization_id]);
  const oldPaystackSub = fakePaystack.state.subscriptions.find((x) => x.subscription_code === smallSubBefore.paystack_subscription_code);
  const newPaystackSub = fakePaystack.state.subscriptions.find((x) => x.subscription_code === smallSub.paystack_subscription_code);
  check('after the upgrade, renewals move to the Business plan from the next period', oldPaystackSub?.status === 'disabled' && newPaystackSub?.status === 'active' && fakePaystack.state.plans[newPaystackSub.plan.plan_code].amount === 3_500_000 && newPaystackSub.start_date.startsWith(addDaysIso(endBefore, 1)), { oldPaystackSub, newPaystackSub });
  check('Business: tasks now open', (await small('GET', '/tasks')).status === 200);
  check('Business: 11th employee now allowed', (await small('POST', '/employees', { firstName: 'Eleventh', lastName: 'Person', email: `s11.${stamp}@test.ng` })).status === 201);

  // Paystack renews automatically
  const smallOrgId = r.data.organization.id;
  const signed = (payload, key = BILLING_KEY) => {
    const text = JSON.stringify(payload);
    return fetch(`${BASE}/webhooks/paystack-billing`, { method: 'POST', headers: { 'x-paystack-signature': crypto.createHmac('sha512', key).update(text).digest('hex'), 'Content-Type': 'application/json' }, body: text });
  };
  const renewal = fakePaystack.renew(smallSub.paystack_subscription_code);
  let hook = await signed(renewal, 'sk_test_forged');
  check('billing webhook with a forged signature is rejected', hook.status === 401);
  hook = await signed(renewal);
  await signed(renewal); // Paystack sometimes sends it twice
  r = await small('GET', '/auth/me');
  const nextStart = addDaysIso(endBefore, 1);
  check('automatic renewal: the next month follows straight on', hook.status === 200 && r.data.subscription.periodEnd > endBefore && r.data.subscription.status === 'active', [endBefore, r.data.subscription]);
  const [[renewRows]] = await pool.query("SELECT COUNT(*) AS n, MIN(period_start) AS start FROM billing_payments WHERE organization_id = ? AND kind = 'auto_renewal'", [smallOrgId]);
  check('…counted once, starting the day after the old period', Number(renewRows.n) === 1 && renewRows.start === nextStart, renewRows);

  // Card declined on a renewal
  await signed({ event: 'invoice.payment_failed', data: { subscription: { subscription_code: smallSub.paystack_subscription_code } } });
  r = await small('GET', '/billing');
  check('failed renewal: shown on Billing', /could not charge your card/.test(r.data.subscription.renewalProblem), r.data.subscription);
  r = await small('GET', '/notifications');
  check('…and the owner’s bell', r.data.items.some((n) => n.type === 'billing.payment_failed'), r.data.items.map((n) => n.type));
  r = await small('GET', '/billing/card-link');
  check('owner can open Paystack’s page to change the card', /\/manage\/SUB_test/.test(r.data.link), r.data);

  // Monthly → yearly from the next period
  r = await small('POST', '/billing/change', { plan: 'business', interval: 'yearly' });
  check('switch to yearly from the next period', r.status === 200 && r.data.subscription.nextInterval === 'yearly' && r.data.subscription.nextPlan === 'business', r.data.subscription);
  const [[afterChange]] = await pool.query('SELECT * FROM subscriptions WHERE organization_id = ?', [smallOrgId]);
  const yearlySub = fakePaystack.state.subscriptions.find((x) => x.subscription_code === afterChange.paystack_subscription_code);
  check('…Paystack will charge the yearly price next time', fakePaystack.state.plans[yearlySub.plan.plan_code].amount === 39_598_800, yearlySub);
  r = await small('DELETE', '/billing/change');
  check('a scheduled change can be undone', r.data.subscription.nextPlan === null, r.data.subscription);

  // Auto-renew off and back on
  r = await small('POST', '/billing/auto-renew', { on: false });
  check('turn automatic renewal off', r.data.subscription.autoRenew === false, r.data.subscription);
  r = await small('POST', '/billing/auto-renew', { on: true });
  check('…and back on', r.data.subscription.autoRenew === true, r.data.subscription);

  // The period runs out with no payment…
  await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(CURDATE(), INTERVAL 3 DAY) WHERE organization_id = ?', [smallOrgId]);
  r = await small('GET', '/auth/me');
  check('3 days after the period ends: still works (grace) with a warning', r.data.subscription.status === 'grace' && (await small('GET', '/dashboard')).status === 200, r.data.subscription);
  await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(CURDATE(), INTERVAL 10 DAY) WHERE organization_id = ?', [smallOrgId]);
  check('10 days after: locked until paid', (await small('GET', '/dashboard')).status === 402);
  r = await small('POST', '/billing/checkout', { plan: 'starter', interval: 'yearly' });
  check('expired: can pay again on any plan and interval, full price', r.data.kind === 'renewal' && r.data.amountKobo === 15_598_800, r.data);
  fakePaystack.pay(r.data.reference);
  // Owner closes the tab — Paystack's webhook confirms it instead
  hook = await signed({ event: 'charge.success', data: { reference: r.data.reference } });
  r = await small('GET', '/auth/me');
  check('webhook confirms the payment (new year from today)', hook.status === 200 && r.data.subscription.status === 'active' && r.data.subscription.plan === 'starter' && r.data.subscription.daysLeft >= 364, r.data.subscription);
  r = await staff('POST', '/billing/checkout', { plan: 'business', interval: 'monthly' });
  check('only the owner can pay', r.status === 403);
  r = await staff('GET', '/billing');
  check('staff don’t see prices or payments', r.status === 200 && r.data.isOwner === false && !r.data.plans && !r.data.payments, r.data);

  // Organisations from before plans keep full access
  const legacy = client();
  const legacyEmail = `legacy${stamp}@test.ng`;
  r = await legacy('POST', '/auth/register', { fullName: 'Old Timer', organizationName: 'Old Co', email: legacyEmail, password: 'secret123', plan: 'starter' });
  r = await legacy('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(legacyEmail) });
  await pool.query('DELETE FROM subscriptions WHERE organization_id = ?', [r.data.organization.id]);
  r = await legacy('GET', '/auth/me');
  check('organisation from before plans: full access, no payment', r.data.subscription.isLegacy && r.data.subscription.status === 'active' && (await legacy('GET', '/payroll')).status === 200, r.data.subscription);

  console.log('\nBilling switched off (free early access)');
  billing.enabled = false;
  const freeCo = client();
  const freeEmail = `free${stamp}@test.ng`;
  r = await freeCo('GET', '/billing/config');
  check('sign-up page can see billing is off', r.data.enabled === false, r.data);
  r = await freeCo('POST', '/auth/register', { fullName: 'Free Rider', organizationName: 'Free Co', email: freeEmail, password: 'secret123' });
  check('sign up needs no plan while billing is off', r.status === 201, r.data);
  r = await freeCo('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(freeEmail) });
  check('free organisation gets everything', r.data.subscription.status === 'free' && r.data.subscription.usable && r.data.subscription.features.includes('payroll'), r.data.subscription);
  check('…and can use paid features', (await freeCo('GET', '/payroll')).status === 200 && (await freeCo('GET', '/tasks')).status === 200);
  r = await freeCo('GET', '/billing');
  check('nothing to pay while free', r.data.plans.every((p) => p.quotes.monthly.allowed === false && p.quotes.yearly.allowed === false), r.data.plans);
  r = await small('GET', '/auth/me');
  check('organisations that already paid keep their plan', r.data.subscription.status === 'active' && r.data.subscription.plan === 'starter', r.data.subscription);

  billing.enabled = true; // switched on: free organisations get their trial from BILLING_START_DATE
  billing.startDate = new Date().toISOString().slice(0, 10);
  r = await freeCo('GET', '/auth/me');
  check('switching billing on gives free organisations a trial from the start date', r.data.subscription.status === 'trial' && r.data.subscription.daysLeft === 13, r.data.subscription);
  billing.startDate = '2026-01-01';
  r = await freeCo('GET', '/auth/me');
  check('…but never before they signed up', r.data.subscription.status === 'trial' && r.data.subscription.daysLeft === 13, r.data.subscription);
  billing.startDate = null;

  console.log('\nMonthly attendance adherence & holidays');
  const { monthAdherence } = await import('../src/utils/adherence.js');
  // October 2026: 22 working days. 1 holiday, 5 days leave → 16 expected days.
  const adh = monthAdherence({
    month: '2026-10', today: '2026-11-04', startDate: '2026-01-01',
    records: [
      { work_date: '2026-10-02', is_late: 1 },
      { work_date: '2026-10-05', is_late: 0, review_status: 'pending' },
      { work_date: '2026-10-06', is_late: 0, review_status: 'rejected' },
      { work_date: '2026-10-07', is_late: 0 },
    ],
    leaves: [{ start_date: '2026-10-12', end_date: '2026-10-16' }],
    holidays: ['2026-10-01'],
  });
  check('holidays skipped, leave not held against them', adh.holidays === 1 && adh.onLeave === 5 && adh.expected === 16, adh);
  check('on time / late / absent counted (rejected clock-in = absent, flagged noted)', adh.onTime === 2 && adh.late === 1 && adh.absent === 13 && adh.flagged === 1, adh);
  check('adherence = on time ÷ expected days', adh.adherence === Math.round((2 / 16) * 100), adh.adherence);
  const starter = monthAdherence({ month: '2026-10', today: '2026-11-04', startDate: '2026-10-26', records: [], leaves: [], holidays: [] });
  check('days before someone started are not counted', starter.expected === 5 && starter.absent === 5, starter);
  const todayOnly = monthAdherence({ month: '2026-11', today: '2026-11-02', startDate: null, records: [], leaves: [], holidays: [] });
  check('today isn\'t "absent" until the day is over', todayOnly.absent === 0 && todayOnly.adherence === null, todayOnly);

  const yearNow = new Date().getFullYear();
  r = await owner('POST', '/organization/holidays/national', { year: yearNow });
  check('add Nigeria\'s 6 fixed public holidays', r.status === 201 && r.data.added === 6, r.data);
  r = await owner('POST', '/organization/holidays/national', { year: yearNow });
  check('…adding again changes nothing', r.data.added === 0);
  r = await owner('POST', '/organization/holidays', { date: `${yearNow}-04-03`, name: 'Good Friday' });
  check('add a moving holiday', r.status === 201 && r.data.length === 7, r.data.length);
  r = await staff('POST', '/organization/holidays', { date: `${yearNow}-04-06`, name: 'Easter Monday' });
  check('staff cannot add holidays', r.status === 403);
  r = await staff('GET', `/organization/holidays?year=${yearNow}`);
  check('everyone can see the holidays', r.status === 200 && r.data.length === 7);

  r = await staff('GET', '/me/attendance');
  check('my attendance includes this month\'s adherence', r.data.adherence && 'onTime' in r.data.adherence && 'previousAdherence' in r.data, r.data.adherence);
  r = await owner('GET', `/attendance/monthly?month=${thisMonth}`);
  check('monthly view: one row per active employee, with team totals', r.status === 200 && r.data.people.length >= 5 && r.data.team && 'adherence' in r.data.team, r.data.team);
  const sortedOk = r.data.people.every((p, i, a) => i === 0 || (a[i - 1].adherence ?? 101) <= (p.adherence ?? 101));
  check('worst adherence first (who needs attention)', sortedOk, r.data.people.map((p) => p.adherence));
  r = await sup('GET', `/attendance/monthly?month=${thisMonth}`);
  check('supervisor sees only their team', r.data.people.every((p) => [staffId, supId].includes(p.employeeId)), r.data.people.map((p) => p.employeeId));
  r = await staff('GET', `/attendance/monthly?month=${thisMonth}`);
  check('staff cannot see everyone\'s adherence', r.status === 403);

  console.log('\nAnnouncements & comments');
  r = await sup('GET', '/announcements/groups');
  check('a team supervisor can post to their own team only', r.data.length === 1 && r.data[0].type === 'team' && r.data[0].label === 'Field Sales team', r.data);
  r = await sup('POST', '/announcements', { audienceType: 'company', title: 'Hello all', body: 'Hi' });
  check('…not to the whole company', r.status === 403, r.data);
  r = await staff('POST', '/announcements', { audienceType: 'team', audienceId: teamId, title: 'Hello team', body: 'Hi' });
  check('an employee can’t post', r.status === 403, r.data);
  const postForm = new FormData();
  postForm.append('audienceType', 'team');
  postForm.append('audienceId', String(teamId));
  postForm.append('title', 'Standup moved to 9:30');
  postForm.append('body', 'From Monday our daily standup starts at 9:30.\nBring your numbers.');
  postForm.append('file', new Blob(['Agenda: numbers, blockers'], { type: 'text/plain' }), 'agenda.txt');
  r = await sup('POST', '/announcements', postForm);
  check('supervisor posts to the team with an attachment', r.status === 201 && r.data.audience_name === 'Field Sales team' && r.data.attachment_name === 'agenda.txt', r.data);
  const teamPost = r.data.id;
  r = await staff('GET', '/notifications');
  check('team members get a bell notification', r.data.items.some((n) => n.type === 'announcement.posted' && /Standup moved/.test(n.title)), r.data.items.map((n) => n.title));
  r = await staff('GET', '/announcements/unseen');
  check('dashboard shows it as new', r.data.some((p) => p.id === teamPost), r.data);
  r = await staff('GET', '/announcements');
  check('team member sees it in the feed', r.data.posts.some((p) => p.id === teamPost && !p.canManage && p.stats === null), r.data);
  check('…and it’s marked seen', (await staff('GET', '/announcements/unseen')).data.length === 0);

  r = await owner('POST', '/announcements', { audienceType: 'company', title: 'Office closed on Friday', body: 'Public holiday — enjoy the long weekend.', needsAck: true, sendEmail: true, isPinned: true });
  check('owner posts to everyone (pinned, needs acknowledgement)', r.status === 201 && r.data.is_pinned === 1 && r.data.needs_ack === 1, r.data);
  const companyPost = r.data.id;
  check('“also email everyone” emails the group', /Office closed on Friday/.test(lastEmail(staffEmail)?.subject), lastEmail(staffEmail));
  r = await staff('GET', '/announcements');
  check('pinned posts come first', r.data.posts[0].id === companyPost, r.data.posts.map((p) => p.id));

  r = await staff('POST', `/announcements/${teamPost}/comments`, { body: 'Noted — will 9:30 work for the field team too?' });
  check('staff comment on a post', r.status === 201 && r.data.mine, r.data);
  const staffComment = r.data.id;
  r = await sup('GET', '/notifications');
  check('the author is told about comments', r.data.items.some((n) => n.type === 'announcement.comment' && /Chidi Eze commented/.test(n.title)), r.data.items.map((n) => n.title));
  await sup('POST', `/announcements/${teamPost}/comments`, { body: 'Yes, everyone.' });
  r = await staff('GET', '/notifications');
  check('when the author replies, commenters are told', r.data.items.some((n) => n.type === 'announcement.comment' && /Bola Ade commented/.test(n.title)), r.data.items.map((n) => n.title));

  r = await staff('POST', `/announcements/${companyPost}/acknowledge`);
  check('staff tap “I’ve read this”', r.status === 200);
  r = await owner('GET', '/announcements');
  const ownerView = r.data.posts.find((p) => p.id === companyPost);
  check('the author sees how many have seen and acknowledged it', ownerView.canManage && ownerView.stats.acknowledged === 1 && ownerView.stats.seen >= 1 && ownerView.stats.audience >= 3, ownerView.stats);
  r = await owner('GET', `/announcements/${companyPost}/readers`);
  check('…and exactly who', r.data.some((p) => p.name === 'Chidi Eze' && p.acknowledgedAt) && r.data.some((p) => p.name === 'Dayo Out' && !p.hasLogin), r.data);
  r = await staff('GET', `/announcements/${companyPost}/readers`);
  check('staff can’t see who read it', r.status === 403);

  r = await staff('DELETE', `/announcements/${teamPost}`);
  check('staff can’t delete a post', r.status === 403);
  r = await staff('DELETE', `/announcements/comments/${staffComment}`);
  check('…but can delete their own comment', r.status === 204);
  r = await sup('PATCH', `/announcements/${teamPost}`, { isPinned: true });
  check('the author can pin their post', r.status === 200 && r.data.is_pinned === 1, r.data);
  r = await sup('GET', '/announcements');
  check('a supervisor doesn’t see posts for other groups', r.data.posts.every((p) => ['company', 'team'].includes(p.audience_type)), r.data.posts.map((p) => p.audience_name));

  console.log('\nTeam resources (documents & files)');
  r = await sup('POST', '/resources', { kind: 'document', audienceType: 'team', audienceId: teamId, title: 'Field sales script', description: 'What to say on a first visit',
    body: '<h2>Opening</h2><p>Good morning, I’m <strong>from Ada Fashion</strong>.</p><script>alert(1)</script><p onclick="steal()">Ask about <a href="javascript:alert(1)">their stock</a>.</p>', notify: true });
  check('supervisor writes a document for the team', r.status === 201 && r.data.kind === 'document' && r.data.version === 1 && r.data.canManage, r.data);
  const scriptDoc = r.data.id;
  check('…the HTML is cleaned (no scripts, handlers or javascript: links)', !/script|onclick|javascript/.test(r.data.body) && /<strong>from Ada Fashion<\/strong>/.test(r.data.body), r.data.body);
  r = await staff('GET', '/notifications');
  check('the team is told it was shared', r.data.items.some((n) => n.type === 'resource.shared' && /Field sales script/.test(n.title)), r.data.items.map((n) => n.title));
  r = await staff('GET', '/resources');
  check('team members see it', r.data.some((x) => x.id === scriptDoc && !x.canManage), r.data);
  r = await staff('PATCH', `/resources/${scriptDoc}`, { body: '<p>hacked</p>' });
  check('team members can’t edit it', r.status === 403);
  r = await sup('PATCH', `/resources/${scriptDoc}`, { body: '<h2>Opening</h2><p>Good morning! Version two.</p>' });
  check('supervisor edits it → version 2, old one kept', r.data.version === 2 && r.data.versions.length === 1 && r.data.versions[0].version === 1, r.data);
  r = await staff('GET', `/resources/${scriptDoc}/versions/1`);
  check('anyone in the team can read an older version', r.status === 200 && /from Ada Fashion/.test(r.data.body), r.data);

  const brochure = new FormData();
  brochure.append('kind', 'file');
  brochure.append('audienceType', 'team');
  brochure.append('audienceId', String(teamId));
  brochure.append('title', 'Price list');
  brochure.append('file', new Blob(['%PDF-1.4 fake price list v1'], { type: 'application/pdf' }), 'prices-v1.pdf');
  r = await sup('POST', '/resources', brochure);
  check('upload a PDF for the team', r.status === 201 && r.data.kind === 'file' && r.data.file_name === 'prices-v1.pdf', r.data);
  const priceList = r.data.id;
  r = await sup('PATCH', `/resources/${priceList}`, { body: '<p>edit the pdf</p>' });
  check('uploaded files can’t be edited in Workard', r.status === 422, r.data);
  const v2 = new FormData();
  v2.append('file', new Blob(['%PDF-1.4 fake price list v2'], { type: 'application/pdf' }), 'prices-v2.pdf');
  r = await sup('POST', `/resources/${priceList}/file`, v2);
  check('…upload a new version instead (the old one is kept)', r.data.version === 2 && r.data.file_name === 'prices-v2.pdf' && r.data.versions[0].file_name === 'prices-v1.pdf', r.data);
  r = await sup('POST', `/resources/${priceList}/send`, { email: true, message: 'New prices from Monday' });
  check('“send to team” tells everyone in it', r.data.people >= 1 && /Price list/.test(lastEmail(staffEmail)?.subject), [r.data, lastEmail(staffEmail)?.subject]);
  r = await sup('POST', '/resources', { kind: 'document', audienceType: 'company', title: 'Company handbook', body: '<p>Hi</p>' });
  check('a supervisor can’t share with the whole company', r.status === 403, r.data);
  r = await owner('POST', '/resources', { kind: 'document', audienceType: 'company', title: 'Company handbook', body: '<p>Welcome to Ada Fashion House.</p>' });
  check('the owner shares with everyone', r.status === 201 && r.data.audience_name === 'Everyone', r.data);
  r = await staff('DELETE', `/resources/${priceList}`);
  check('team members can’t delete materials', r.status === 403);

  console.log('\nProjects & tasks with several people');
  r = await sup('GET', '/projects/groups');
  check('supervisor can create projects for their team', r.data.length === 1 && r.data[0].type === 'team', r.data);
  r = await sup('POST', '/projects', { name: 'Lekki store launch', audienceType: 'team', audienceId: teamId, color: '#eb6834', dueDate: '2026-12-15' });
  check('create a project for the team', r.status === 201 && r.data.audience_name === 'Field Sales team' && r.data.canManage, r.data);
  const projectId = r.data.id;
  r = await staff('POST', '/projects', { name: 'My own', audienceType: 'team', audienceId: teamId });
  check('an employee can’t create projects', r.status === 403);
  r = await sup('POST', '/tasks', { title: 'Visit 20 stores in Lekki', projectId, assigneeIds: [staffId, supId], dueDate: '2026-12-01', checklist: [] });
  check('a task for two people inside the project (first = lead)', r.status === 201 && r.data.assignees.length === 2 && r.data.assignees[0].id === staffId && r.data.assignees[0].is_lead && r.data.project_name === 'Lekki store launch', r.data);
  const sharedTask = r.data.id;
  r = await staff('GET', '/notifications');
  check('everyone on it gets a bell notification', r.data.items.some((n) => n.type === 'task.assigned' && /Visit 20 stores/.test(n.title)), r.data.items.map((n) => n.title));
  r = await sup('GET', '/tasks?view=mine');
  check('…and it’s in each person’s “My tasks” (not only the lead’s)', r.data.tasks.some((t) => t.id === sharedTask), r.data.tasks.map((t) => t.title));
  r = await staff('PATCH', `/tasks/${sharedTask}/status`, { status: 'in_progress' });
  check('anyone on the task can move it along', r.status === 200 && r.data.status === 'in_progress', r.data);
  r = await staff('POST', `/tasks/${sharedTask}/comments`, { body: 'Done 8 so far' });
  r = await sup('GET', '/notifications');
  check('comments reach everyone on the task', r.data.items.some((n) => n.type === 'task.comment' && /Chidi Eze commented/.test(n.title)), r.data.items.map((n) => n.title));
  // @mentions: only the tagged person is notified; everyone still sees the comment
  r = await owner('GET', `/tasks/${sharedTask}`);
  const chidiUser = r.data.mentionable.find((p) => p.name === 'Chidi Eze');
  check('people on the task (and whoever set it) can be tagged', r.data.mentionable.length >= 2 && chidiUser, r.data.mentionable);
  const supBefore = (await sup('GET', '/notifications')).data.items.length;
  r = await owner('POST', `/tasks/${sharedTask}/comments`, { body: `@Chidi Eze please share the photos`, mentionUserIds: [chidiUser.userId, 999999] });
  const tagged = r.data[r.data.length - 1];
  check('a comment with a tag (strangers ignored)', r.status === 201 && tagged.mentions.length === 1 && tagged.mentions[0].user_id === chidiUser.userId, tagged);
  r = await staff('GET', '/notifications');
  check('the tagged person gets “mentioned you”', r.data.items.some((n) => n.type === 'task.mention' && /mentioned you on “Visit 20 stores/.test(n.title)), r.data.items.map((n) => n.title));
  r = await sup('GET', '/notifications');
  check('…the others on the task are NOT notified', r.data.items.length === supBefore, r.data.items.slice(0, 3).map((n) => n.title));
  r = await sup('GET', `/tasks/${sharedTask}`);
  check('…but they can still read it', r.data.comments.some((c) => c.body.includes('please share the photos') && c.mentions.length === 1));

  r = await sup('POST', '/tasks', { title: 'Print flyers', projectId, assigneeIds: [staffId], checklist: [] });
  await staff('PATCH', `/tasks/${r.data.id}/status`, { status: 'done' });
  r = await staff('GET', `/projects/${projectId}`);
  const chidiOnBoard = r.data.people?.find((p) => p.first_name === 'Chidi');
  check('project board: tasks, progress and each person’s share', r.data.task_total === 2 && r.data.task_done === 1 && chidiOnBoard?.done === 1 && chidiOnBoard?.in_progress === 1 && r.data.people.some((p) => p.first_name === 'Bola' && p.in_progress === 1), r.data);
  r = await staff('GET', '/projects');
  check('team members see the project', r.data.some((p) => p.id === projectId && !p.canManage), r.data);
  r = await staff('PATCH', `/projects/${projectId}`, { name: 'Hijacked' });
  check('…but can’t change it', r.status === 403);
  r = await sup('POST', '/tasks', { title: 'Outside help', assigneeIds: [staffId, otherId], checklist: [] });
  check('you can only add people you manage to a task', r.status === 422, r.data);
  r = await sup('PATCH', `/tasks/${sharedTask}`, { assigneeIds: [staffId] });
  check('change who’s on a task', r.data.assignees.length === 1 && r.data.assignees[0].id === staffId, r.data.assignees);
  r = await sup('GET', `/tasks?projectId=${projectId}&view=team`);
  check('filter tasks by project', r.data.tasks.length === 2, r.data.tasks.map((t) => t.title));
  r = await sup('DELETE', `/projects/${projectId}`);
  r = await sup('GET', `/tasks/${sharedTask}`);
  check('deleting a project keeps its tasks', r.status === 200 && r.data.project_id === null, r.data);

  r = await owner('GET', '/attendance');
  check('the register includes staff IDs (for search)', r.status === 200 && r.data.register.every((x) => 'staff_id' in x), r.data.register?.[0]);
  r = await owner('GET', `/attendance/monthly?month=${thisMonth}`);
  check('the monthly breakdown includes staff IDs', r.status === 200 && r.data.people.every((x) => 'staffId' in x));

  console.log('\nTeam performance (CEO view)');
  const ownerEmployeeId = (await owner('GET', '/auth/me')).data.employee?.id;
  r = await owner('GET', `/performance?month=${thisMonth}`);
  const chidiPerf = r.data.people?.find((p) => p.employeeId === staffId);
  check('owner sees everyone with tasks, attendance and a score', r.status === 200 && r.data.people.length >= 3 && chidiPerf?.tasks.done >= 1 && chidiPerf.attendance.expected >= 0 && 'score' in chidiPerf, chidiPerf);
  check('the owner isn’t measured on their own page', !r.data.people.some((p) => p.employeeId === ownerEmployeeId), r.data.people.map((p) => p.firstName));
  check('team totals add up', r.data.team.done === r.data.people.reduce((a, p) => a + p.tasks.done, 0) && r.data.team.people === r.data.people.length, r.data.team);
  check('best score first', r.data.people.every((p, i, all) => i === 0 || (all[i - 1].score ?? -1) >= (p.score ?? -1)), r.data.people.map((p) => p.score));
  check('score is the average of what exists (never invented)', r.data.people.every((p) => {
    const parts = [p.delivery, p.attendance.rate, p.review === null ? null : Math.round((p.review / 5) * 100)].filter((x) => x !== null);
    return parts.length ? p.score === Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : p.score === null;
  }), r.data.people);
  r = await owner('GET', `/performance?month=${thisMonth}&months=3`);
  check('3-month view covers three months', r.data.months?.length === 3, r.data.months);
  r = await sup('GET', `/performance?month=${thisMonth}`);
  check('a supervisor sees only their team', r.status === 200 && r.data.people.every((p) => [staffId, supId].includes(p.employeeId)), r.data.people?.map((p) => p.firstName));
  r = await staff('GET', '/performance');
  check('an employee can’t see team performance', r.status === 403);
  r = await owner('GET', '/performance?months=2');
  check('only 1, 3 or 6 months', r.status === 422 || r.status === 400, r.status);

  console.log('\nMeetings & stand-ups (LiveKit)');
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const nowTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' });
  r = await sup('GET', '/meetings/groups');
  check('supervisor can schedule meetings for their team', r.data.length === 1 && r.data[0].type === 'team', r.data);
  const weekend = [0, 6].includes(new Date(`${todayIso}T12:00:00`).getDay()); // tests can run on a Saturday too
  r = await sup('POST', '/meetings', { title: 'Daily stand-up', audienceType: 'team', audienceId: teamId, date: todayIso, time: nowTime, durationMinutes: 15, repeat: weekend ? 'daily' : 'weekdays', isStandup: true });
  check('schedule a daily stand-up for the team (weekdays)', r.status === 201 && r.data.audience_name === 'Field Sales team' && r.data.people.some((p) => p.first_name === 'Chidi'), r.data);
  const standupId = r.data.id;
  r = await staff('GET', '/notifications');
  check('the team is invited (bell)', r.data.items.some((n) => n.type === 'meeting.invited' && /Daily stand-up/.test(n.title)), r.data.items.map((n) => n.title));
  check('…and by email', /Invitation: Daily stand-up/.test(lastEmail(staffEmail)?.subject), lastEmail(staffEmail)?.subject);
  r = await staff('GET', `/meetings?from=${todayIso}&to=${addDaysIso(todayIso, 13)}`);
  const occ = r.data.filter((m) => m.meetingId === standupId);
  check('the calendar shows each weekday (10 in two weeks)', weekend ? occ.length === 14 : occ.length === 10 && occ.every((o) => ![0, 6].includes(new Date(`${o.date}T12:00:00`).getDay())), occ.map((o) => o.date));
  r = await sup('POST', '/meetings', { title: 'All hands', audienceType: 'company', date: todayIso, time: '09:00' });
  check('a supervisor can’t schedule for the whole company', r.status === 403);
  r = await staff('POST', '/meetings', { title: 'Coffee chat', audienceType: 'people', inviteeIds: [supId], date: addDaysIso(todayIso, 1), time: '10:00' });
  check('anyone can invite chosen people', r.status === 201 && r.data.people.length === 2, r.data);
  const chatId = r.data.id;
  r = await owner('GET', `/meetings/${chatId}`);
  check('people not invited can’t see a private meeting', r.status === 404);

  r = await staff('POST', `/meetings/${standupId}/join?date=${todayIso}`);
  const payload = r.data.token ? JSON.parse(Buffer.from(r.data.token.split('.')[1], 'base64url').toString()) : {};
  check('joining gives a LiveKit token for today’s room only', r.status === 200 && r.data.url === 'wss://test.livekit.cloud' && payload.video?.room === r.data.room && payload.video?.roomJoin === true && r.data.room.endsWith(todayIso) && payload.name === 'Chidi Eze', [r.data, payload]);
  r = await owner('POST', `/meetings/${chatId}/join?date=${addDaysIso(todayIso, 1)}`);
  check('people who aren’t invited can’t join', r.status === 404, r.data);
  r = await staff('POST', `/meetings/${chatId}/join?date=${addDaysIso(todayIso, 1)}`);
  check('the room only opens 15 minutes before', r.status === 409 && /room opens/.test(r.data.message), r.data);

  await pool.query("UPDATE tasks SET status = 'done', completed_at = NOW() WHERE id = ?", [sharedTask]);
  r = await sup('GET', `/meetings/${standupId}/standup?date=${todayIso}`);
  const chidiStandup = r.data.people?.find((p) => p.first_name === 'Chidi');
  check('stand-up board: each person’s done / doing tasks, and who joined', chidiStandup?.done.some((t) => t.title === 'Visit 20 stores in Lekki') && chidiStandup.joined === true && r.data.people.some((p) => p.first_name === 'Bola' && p.joined === false), r.data.people);
  r = await staff('PATCH', `/meetings/${standupId}`, { title: 'Hijacked' });
  check('only the organiser can change it', r.status === 403);
  r = await sup('DELETE', `/meetings/${standupId}`);
  r = await staff('GET', '/notifications');
  check('cancelling tells everyone', r.data.items.some((n) => n.type === 'meeting.cancelled'), r.data.items.map((n) => n.type));
  r = await staff('POST', `/meetings/${standupId}/join?date=${todayIso}`);
  check('a cancelled meeting can’t be joined', r.status === 404 || r.status === 409, r.data);

  // Flexible repeats: Wednesdays 10:00 and Fridays 14:30
  const nextDow = (dow) => { let d = addDaysIso(todayIso, 1); while (new Date(`${d}T12:00:00Z`).getUTCDay() !== dow) d = addDaysIso(d, 1); return d; };
  const wed = nextDow(3);
  r = await staff('POST', '/meetings', { title: 'Wed & Fri sync', audienceType: 'people', inviteeIds: [supId], date: wed, time: '10:00', repeat: 'weekly', repeatDays: [{ day: 3, time: '10:00' }, { day: 5, time: '14:30' }] });
  const syncId = r.data.id;
  check('weekly on chosen days, each with its own time', r.status === 201 && r.data.repeatText === 'Every Wednesday 10:00 and Friday 14:30' && r.data.upcoming[0].date === wed && r.data.upcoming[0].time === '10:00' && r.data.upcoming[1].date === addDaysIso(wed, 2) && r.data.upcoming[1].time === '14:30', r.data.upcoming);
  r = await staff('GET', `/meetings?from=${wed}&to=${addDaysIso(wed, 13)}`);
  const syncDates = r.data.filter((m) => m.meetingId === syncId).map((m) => m.startsAt);
  check('the calendar shows each day at its own time', syncDates.join() === [`${wed} 10:00`, `${addDaysIso(wed, 2)} 14:30`, `${addDaysIso(wed, 7)} 10:00`, `${addDaysIso(wed, 9)} 14:30`].join(), syncDates);
  r = await staff('PATCH', `/meetings/${syncId}`, { repeatEvery: 2 });
  check('every 2 weeks skips the week in between', r.data.repeatText.startsWith('Every 2 weeks on') && r.data.upcoming[2].date === addDaysIso(wed, 14), r.data.upcoming);
  r = await staff('POST', `/meetings/${syncId}/skip`, { date: addDaysIso(wed, 2) });
  check('cancel just one date: it disappears, the rest stay', r.status === 200 && !r.data.upcoming.some((u) => u.date === addDaysIso(wed, 2)) && r.data.upcoming[0].date === wed && r.data.skippedDates.includes(addDaysIso(wed, 2)), r.data);
  r = await sup('GET', '/notifications');
  check('…and the people invited are told', r.data.items.some((n) => n.type === 'meeting.cancelled' && /is off/.test(n.title)), r.data.items.map((n) => n.title));
  r = await staff('POST', `/meetings/${syncId}/join?date=${addDaysIso(wed, 2)}`);
  check('a cancelled date can’t be joined', r.status === 409, r.data);
  r = await staff('DELETE', `/meetings/${syncId}/skip?date=${addDaysIso(wed, 2)}`);
  check('…and it can be brought back', r.data.upcoming.some((u) => u.date === addDaysIso(wed, 2)), r.data.upcoming);
  r = await sup('POST', `/meetings/${syncId}/skip`, { date: wed });
  check('only the organiser can cancel a date', r.status === 403);
  r = await staff('POST', '/meetings', { title: 'No days', audienceType: 'people', inviteeIds: [supId], date: wed, time: '10:00', repeat: 'weekly', repeatDays: [] });
  check('weekly needs at least one day', r.status === 422 && r.data.errors?.repeatDays, r.data);
  r = await staff('POST', '/meetings', { title: 'Month end', audienceType: 'people', inviteeIds: [supId], date: '2027-01-31', time: '16:00', repeat: 'monthly' });
  check('monthly on the 31st falls on the last day of shorter months', r.data.repeatText === 'Monthly on the 31st' && r.data.upcoming.slice(0, 3).map((u) => u.date).join() === '2027-01-31,2027-02-28,2027-03-31', r.data.upcoming);
  r = await staff('POST', '/meetings', { title: 'Every other day', audienceType: 'people', inviteeIds: [supId], date: wed, time: '08:00', repeat: 'daily', repeatEvery: 2, repeatUntil: addDaysIso(wed, 6) });
  check('every 2 days, until a date', r.data.upcoming.map((u) => u.date).join() === [wed, addDaysIso(wed, 2), addDaysIso(wed, 4), addDaysIso(wed, 6)].join(), r.data.upcoming);

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



  console.log('\nOffboarding (resignation, 24-hour exit)');
  r = await sup('GET', '/offboarding/mine');
  check('notice period defaults to 30 days', r.data.noticeDays === 30 && r.data.offboarding === null, r.data);
  r = await sup('POST', '/offboarding/resign', { reason: 'Relocating to Abuja' });
  const resignId = r.data.id;
  check('an employee resigns: 30-day notice starts', r.status === 201 && r.data.status === 'notice' && r.data.last_day === addDaysIso(todayIso, 30) && r.data.isLeaver, r.data);
  r = await sup('POST', '/offboarding/resign', {});
  check('…only once', r.status === 409);
  r = await hr('GET', '/notifications');
  check('HR is told (bell + email)', r.data.items.some((n) => n.type === 'offboarding.resigned' && /has resigned/.test(n.title)) && /has resigned/.test(lastEmail(hrEmail)?.subject || ''), r.data.items.map((n) => n.title));
  r = await hr('GET', '/onboarding/templates?kind=offboarding');
  const resignTpl = r.data.find((t) => t.suits === 'resignation');
  const quickTpl = r.data.find((t) => t.suits === 'termination');
  check('two starter offboarding checklists', resignTpl && quickTpl, r.data.map((t) => t.name));
  r = await hr('GET', '/onboarding/templates');
  check('…kept apart from the onboarding ones', !r.data.some((t) => t.id === resignTpl.id));
  r = await hr('POST', `/offboarding/${resignId}/checklist`, { templateId: resignTpl.id });
  const handover = r.data.items?.find((i) => /handover/i.test(i.title));
  check('HR sends the offboarding checklist', r.status === 200 && r.data.status === 'in_progress' && r.data.items.length >= 5 && handover?.asks_for_note === 1 && r.data.items.every((i) => i.due_at <= r.data.ends_at), r.data);
  check('…the leaver is told (bell + email)', /offboarding checklist/i.test(lastEmail(supEmail)?.subject || ''), lastEmail(supEmail)?.subject);
  r = await sup('PATCH', `/offboarding/items/${handover.id}`, { done: true });
  check('the handover note needs writing', r.status === 422 && r.data.errors?.note, r.data);
  r = await sup('PATCH', `/offboarding/items/${handover.id}`, { done: true, note: 'Clients list is in the shared drive; Tunde takes Lekki.' });
  check('…tick it with the note', r.data.items.find((i) => i.id === handover.id).done_at && /Tunde takes Lekki/.test(r.data.items.find((i) => i.id === handover.id).note));
  const hrOffItem = r.data.items.find((i) => i.owner === 'hr');
  r = await sup('PATCH', `/offboarding/items/${hrOffItem.id}`, { done: true });
  check('the leaver can’t tick HR’s items', r.status === 403);
  r = await freeCo('GET', `/offboarding/${resignId}`);
  check('others can’t see someone’s offboarding', r.status === 404 || r.status === 403);
  r = await sup('POST', `/offboarding/${resignId}/withdraw`);
  check('the employee can withdraw their resignation', r.data.status === 'withdrawn', r.data);
  r = await hr('GET', '/notifications');
  check('…and HR is told', r.data.items.some((n) => n.type === 'offboarding.withdrawn'));

  r = await owner('POST', '/employees', { firstName: 'Temi', lastName: 'Ade', email: `temi${stamp}@test.ng`, sendInvite: false });
  const temiId = r.data.employee.id;
  r = await sup('POST', '/offboarding', { employeeId: temiId, exitType: 'termination', templateId: quickTpl.id });
  check('employees can’t exit people', r.status === 403);
  r = await hr('POST', '/offboarding', { employeeId: temiId, exitType: 'termination', templateId: 999999 });
  check('a wrong checklist is refused before anything starts', r.status === 422, r.data);
  r = await hr('POST', '/offboarding', { employeeId: temiId, exitType: 'termination', templateId: quickTpl.id, reason: 'End of contract' });
  const termId = r.data.id;
  const hoursLeft = (new Date(r.data.ends_at.replace(' ', 'T')) - Date.now()) / 3600_000;
  check('HR exits someone with a 24-hour checklist', r.status === 201 && r.data.exit_type === 'termination' && hoursLeft > 23 && hoursLeft <= 24.01 && r.data.items.length >= 4, [r.data.status, hoursLeft]);
  check('24-hour exit: every step is due when the 24 hours end', r.data.items.every((i) => i.due_at === r.data.ends_at), r.data.items.map((i) => i.due_at));
  for (const item of r.data.items) r = await hr('PATCH', `/offboarding/items/${item.id}`, { done: true, note: item.asks_for_note ? 'Done with HR' : undefined });
  check('everything ticked → checklist complete', r.data.checklist_done_at, r.data);
  await pool.query('UPDATE offboardings SET ends_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [termId]);
  const { processEndings } = await import('../src/services/offboardingService.js');
  await processEndings();
  r = await hr('GET', `/employees/${temiId}`);
  check('when the time is up they leave automatically', r.data.status === 'exited', r.data.status);
  r = await hr('GET', `/offboarding/${termId}`);
  check('…and the offboarding shows “exited”', r.data.status === 'exited' && r.data.exited_at, r.data.status);

  r = await owner('POST', '/employees', { firstName: 'Bayo', lastName: 'Lawal', email: `bayo${stamp}@test.ng`, sendInvite: false });
  const bayoId = r.data.employee.id;
  r = await hr('POST', '/offboarding', { employeeId: bayoId, exitType: 'resignation', lastDay: addDaysIso(todayIso, 10) });
  check('HR records a resignation they received (their own last day)', r.data.status === 'notice' && r.data.last_day === addDaysIso(todayIso, 10) && !r.data.template_name, r.data);
  r = await hr('PATCH', `/offboarding/${r.data.id}/last-day`, { lastDay: addDaysIso(todayIso, 5) });
  check('change the last day', r.data.last_day === addDaysIso(todayIso, 5));
  r = await hr('POST', `/offboarding/${r.data.id}/exit-now`);
  check('“Exit now” ends it today', r.data.status === 'exited' && (await hr('GET', `/employees/${bayoId}`)).data.status === 'exited');

  r = await sup('PUT', '/offboarding/settings', { noticeDays: 14 });
  check('only HR changes the notice period', r.status === 403);
  r = await hr('PUT', '/offboarding/settings', { noticeDays: 14 });
  check('HR sets the notice period (e.g. 14 days)', r.data.noticeDays === 14 && (await sup('GET', '/offboarding/mine')).data.noticeDays === 14);
  await hr('PUT', '/offboarding/settings', { noticeDays: 30 });


  console.log('\nMail: your own Gmail / Outlook');
  // "Visit" the sign-in link like a browser, let the fake provider say Allow, follow it back to Workard
  async function connectMail(who, provider, email, { hd, withInbox = false, deny = false } = {}) {
    const start = await who('POST', `/mail/connect/${provider}`, { withInbox });
    if (start.status !== 200) return { start };
    const url = new URL(start.data.url);
    url.searchParams.set('login_hint', email);
    if (hd) url.searchParams.set('fake_hd', hd);
    if (deny) url.searchParams.set('fake_deny', '1');
    const atProvider = await fetch(url, { redirect: 'manual' });
    const callback = new URL(atProvider.headers.get('location'));
    const callbackPath = `${callback.pathname.replace(/^\/api/, '')}${callback.search}`;
    const back = await fetch(BASE + callbackPath, { redirect: 'manual' });
    return { start, callbackPath, location: back.headers.get('location') || '' };
  }
  const mailForm = (data, files = []) => {
    const form = new FormData();
    form.append('data', JSON.stringify(data));
    for (const f of files) form.append('files', new Blob([f.content], { type: f.type || 'application/octet-stream' }), f.name);
    return form;
  };

  r = await small('GET', '/mail/account');
  check('Mail is not on the Starter plan', r.status === 403 || r.status === 402, r.data);
  r = await owner('GET', '/mail/account');
  check('Mail page: both providers set up, nothing connected yet', r.status === 200 && r.data.providers.google && r.data.providers.microsoft && r.data.account === null, r.data);
  r = await owner('POST', '/mail/send', mailForm({ to: [{ email: 'x@y.com' }], subject: 'Hi', html: '<p>Hi</p>' }));
  check('sending before connecting asks you to connect', r.status === 409, r.data);

  const ownerGmail = `ada.${stamp}@gmail.com`;
  let m = await connectMail(owner, 'google', ownerGmail, { deny: true });
  check('cancelling at Google comes back with a message', /mailError=/.test(m.location) && /cancelled/.test(decodeURIComponent(m.location)), m.location);
  m = await connectMail(owner, 'google', ownerGmail);
  check('connect personal Gmail → back to /mail?connected=google', /\/mail\?connected=google/.test(m.location), m.location);
  check('Gmail asked only to SEND (no inbox permission for personal Gmail)', !/gmail\.modify/.test(m.start.data.url) && /gmail\.send/.test(m.start.data.url) && /code_challenge=/.test(m.start.data.url), m.start.data.url);
  const replay = await fetch(BASE + m.callbackPath, { redirect: 'manual' });
  check('the same sign-in link can’t be used twice', /expired/.test(decodeURIComponent(replay.headers.get('location') || '')), replay.headers.get('location'));
  r = await owner('GET', '/mail/account');
  check('connected as the Gmail address; personal Gmail: send only, inbox “coming soon”', r.data.account?.email === ownerGmail && !r.data.inbox.allowed && /personal Gmail/.test(r.data.inbox.reason || ''), r.data);
  const [[ownerMailRow]] = await pool.query('SELECT refresh_token_enc, access_token_enc FROM mail_accounts WHERE email = ?', [ownerGmail]);
  check('Gmail tokens are stored encrypted, never as plain text', !/^rt_|^at_/.test(ownerMailRow.refresh_token_enc) && ownerMailRow.refresh_token_enc.split(':').length === 3 && !ownerMailRow.access_token_enc.startsWith('at_'));
  r = await owner('GET', '/mail/inbox');
  check('personal Gmail inbox is not readable yet (403)', r.status === 403, r.data);

  // Send: to a customer, cc the supervisor, bcc HR, plus someone outside; one attachment
  const zenithEmail = `zenith${stamp}@test.ng`;
  const sendBody = {
    to: [{ email: zenithEmail, name: 'Zenith Foods' }, { email: 'outsider@example.com' }],
    cc: [{ email: supEmail }],
    bcc: [{ email: hrEmail }],
    subject: 'Your order — délivery update',
    html: '<p>Hello <strong>Zenith</strong>,</p><p>Your order ships Friday.</p><script>alert(1)</script>',
    requestId: `mail-${stamp}-1`,
  };
  const pdf = { name: 'quote.pdf', type: 'application/pdf', content: Buffer.alloc(10_000, 1) };
  r = await owner('POST', '/mail/send', mailForm(sendBody, [pdf]));
  check('email sent through Gmail and recorded', r.status === 201 && r.data.status === 'sent' && r.data.provider === 'google' && r.data.provider_message_id, r.data);
  const sentId = r.data.id;
  check('linked to the customer automatically; attachment kept', r.data.customer_id === custA && r.data.attachments.length === 1 && r.data.attachments[0].size_bytes === 10_000, r.data);
  check('the message is cleaned (no script)', !/script/i.test(r.data.body_html), r.data.body_html);
  const lastGmail = fakeMail.state.sent.at(-1);
  check('Gmail received a real email: To, Cc, Bcc, encoded subject, attachment', /zenith/.test(lastGmail.raw) && lastGmail.bcc.includes(hrEmail) && /=\?UTF-8\?B\?/.test(lastGmail.raw) && /filename\*=UTF-8''quote\.pdf/.test(lastGmail.raw), lastGmail.raw.slice(0, 400));
  const sentCount = fakeMail.state.sent.length;
  r = await owner('POST', '/mail/send', mailForm(sendBody, [pdf]));
  check('double click: the same request is sent only once', r.data.duplicate === true && r.data.id === sentId && fakeMail.state.sent.length === sentCount, r.data);

  // Who can see it
  r = await owner('GET', `/mail/sent/${sentId}`);
  check('sender sees everyone, including bcc', r.data.recipients.length === 4 && r.data.recipients.some((x) => x.kind === 'bcc'), r.data.recipients);
  r = await sup('GET', `/mail/sent/${sentId}`);
  check('cc’d colleague sees it — without the bcc', r.status === 200 && r.data.recipients.length === 3 && !r.data.recipients.some((x) => x.kind === 'bcc'), r.data);
  r = await hr('GET', `/mail/sent/${sentId}`);
  check('bcc’d colleague sees it — only their own bcc line', r.status === 200 && r.data.recipients.filter((x) => x.kind === 'bcc').length === 1 && r.data.recipients.find((x) => x.kind === 'bcc').email === hrEmail, r.data.recipients);
  r = await fin('GET', `/mail/sent/${sentId}`);
  check('someone not on the email can’t open it (even Finance with all customers)', r.status === 404, r.data);
  r = await fin('GET', `/mail/sent?customerId=${custA}`);
  check('…and it isn’t on the customer profile for them', r.data.total === 0, r.data);
  r = await owner('GET', `/mail/sent?customerId=${custA}`);
  check('on the customer profile for the sender', r.data.total === 1 && r.data.emails[0].id === sentId, r.data);
  r = await sup('GET', '/mail/sent?box=received');
  check('colleague sees it under “sent to me”', r.data.emails.some((e) => e.id === sentId), r.data);

  // Attachments & bad input
  r = await owner('POST', '/mail/send', mailForm({ ...sendBody, requestId: undefined }, [{ name: 'a.pdf', content: Buffer.alloc(1_600_000) }, { name: 'b.pdf', content: Buffer.alloc(1_600_000) }]));
  check('attachments over 3 MB in total are refused', r.status === 422 && /3 MB/.test(r.data.message), r.data);
  r = await owner('POST', '/mail/send', mailForm({ ...sendBody, requestId: undefined }, [{ name: 'big.pdf', content: Buffer.alloc(3_200_000) }]));
  check('one file over 3 MB is refused', r.status === 422, r.data);
  r = await owner('POST', '/mail/send', mailForm({ ...sendBody, requestId: undefined }, [{ name: 'setup.exe', content: Buffer.alloc(100) }]));
  check('program files are blocked', r.status === 422 && /setup\.exe/.test(r.data.message), r.data);
  r = await owner('POST', '/mail/send', mailForm({ to: [], subject: 'x', html: '<p>x</p>' }));
  check('an email needs someone in To', r.status === 422, r.data);

  // An expired access token is refreshed quietly
  const tokenCallsBefore = fakeMail.state.tokenCalls;
  await pool.query('UPDATE mail_accounts SET access_expires_at = ? WHERE email = ?', [new Date(Date.now() - 60_000), ownerGmail]);
  r = await owner('POST', '/mail/send', mailForm({ to: [{ email: 'outsider@example.com' }], subject: 'After refresh', html: '<p>ok</p>' }));
  check('expired access token: a new one is fetched and the email goes', r.status === 201 && fakeMail.state.tokenCalls === tokenCallsBefore + 1, r.data);

  // Access cancelled at Google → "reconnect"
  fakeMail.revokeAll(ownerGmail);
  await pool.query('UPDATE mail_accounts SET access_expires_at = ? WHERE email = ?', [new Date(Date.now() - 60_000), ownerGmail]);
  r = await owner('POST', '/mail/send', mailForm({ to: [{ email: 'outsider@example.com' }], subject: 'Will fail', html: '<p>x</p>' }));
  check('access cancelled at Google: “please reconnect”', r.status === 409 && /reconnect/i.test(r.data.message), r.data);
  r = await owner('GET', '/mail/account');
  check('mailbox shows “needs reconnect”', r.data.account.status === 'needs_reconnect', r.data.account);

  // Google Workspace account: inbox can be turned on (Workspace admin trusts Workard)
  const ownerWork = `ada@adafashion${stamp}.ng`;
  m = await connectMail(owner, 'google', ownerWork, { hd: `adafashion${stamp}.ng`, withInbox: true });
  check('Workspace account with inbox: asks to read too', /gmail\.modify/.test(m.start.data.url) && /connected=google/.test(m.location), m);
  r = await owner('GET', '/mail/account');
  check('reconnect replaces the old mailbox; Workspace inbox allowed', r.data.account.email === ownerWork && r.data.account.status === 'active' && r.data.inbox.allowed, r.data);
  const got = fakeMail.receiveGmail(ownerWork, {
    from: `Zenith Foods <${zenithEmail}>`,
    subject: 'Question about invoice',
    html: '<p>Can you resend?</p><script>steal()</script><img src="https://tracker.test/p.gif" onerror="x()">',
    attachments: [{ name: 'po.pdf', mimeType: 'application/pdf', data: Buffer.from('PO-123') }],
  });
  r = await owner('GET', '/mail/inbox');
  check('Inbox lists the conversation with a customer chip', r.status === 200 && r.data.threads.some((t) => t.id === got.threadId && t.unread && t.customer?.id === custA), r.data);
  r = await owner('GET', `/mail/inbox/threads/${got.threadId}`);
  const msg = r.data.messages?.[0];
  check('thread opens; received HTML is cleaned (no script, no onerror)', msg && !/script|onerror/i.test(msg.html) && /resend/.test(msg.html) && msg.attachments[0]?.name === 'po.pdf', msg);
  const att = await fetch(`${BASE}/mail/inbox/messages/${got.messageId}/attachments/${msg.attachments[0].id}?name=po.pdf`, { headers: { Cookie: '' } });
  check('attachments need a log-in', att.status === 401);
  r = await owner('POST', `/mail/inbox/threads/${got.threadId}/read`);
  check('mark as read', r.status === 200, r.data);
  r = await owner('POST', `/mail/inbox/threads/${got.threadId}/messages/${got.messageId}/reply`, mailForm({ mode: 'reply', to: [{ email: zenithEmail }], html: '<p>Resent — thanks!</p>', requestId: `mail-${stamp}-reply` }));
  const replyRaw = fakeMail.state.sent.at(-1);
  check('reply goes in the same Gmail thread with In-Reply-To, “Re:” subject, recorded as a reply', r.status === 201 && r.data.kind === 'reply' && r.data.subject === 'Re: Question about invoice' && replyRaw.threadId === got.threadId && /@sender\.test>/.test(replyRaw.inReplyTo), { data: r.data, replyRaw: replyRaw?.inReplyTo });
  r = await owner('POST', `/mail/inbox/threads/${got.threadId}/messages/${got.messageId}/reply`, mailForm({ mode: 'forward', to: [{ email: supEmail }], html: '<p>FYI</p>' }));
  const fwdRaw = fakeMail.state.sent.at(-1).raw;
  check('forward carries the original attachment', r.status === 201 && r.data.kind === 'forward' && /Fwd:/.test(r.data.subject) && /po\.pdf/.test(fwdRaw), r.data);

  // Microsoft: the supervisor connects Outlook (inbox included), sends to the owner
  const supOutlook = `sup.${stamp}@outlook.com`;
  m = await connectMail(sup, 'microsoft', supOutlook);
  r = await sup('GET', '/mail/account');
  check('Outlook connected with inbox', /connected=microsoft/.test(m.location) && r.data.account?.provider === 'microsoft' && r.data.inbox.allowed, r.data);
  r = await sup('POST', '/mail/send', mailForm({ to: [{ email: ownerEmail, name: 'Ada' }], subject: 'Team update', html: '<p>Done</p>' }, [{ name: 'notes.txt', type: 'text/plain', content: Buffer.from('hello') }]));
  const lastOutlook = fakeMail.state.sent.at(-1);
  check('sent through Outlook (draft → send) and recorded', r.status === 201 && r.data.provider === 'microsoft' && lastOutlook.provider === 'microsoft' && lastOutlook.attachments.includes('notes.txt'), r.data);
  r = await owner('GET', '/mail/sent?box=received');
  check('the owner (a Workard user it went to) sees it', r.data.emails.some((e) => e.subject === 'Team update'), r.data);
  const out = fakeMail.receiveOutlook(supOutlook, { from: 'client@example.com', subject: 'Site visit', html: '<p>Tuesday?</p>', attachments: [{ name: 'map.png', mimeType: 'image/png', data: Buffer.from('png') }] });
  r = await sup('GET', '/mail/inbox');
  check('Outlook inbox lists the conversation', r.data.threads?.some((t) => t.id === out.threadId && t.unread), r.data);
  r = await sup('GET', `/mail/inbox/threads/${out.threadId}`);
  check('Outlook thread with attachment', r.data.messages?.[0]?.attachments?.[0]?.name === 'map.png', r.data);
  r = await sup('POST', `/mail/inbox/threads/${out.threadId}/messages/${out.messageId}/reply`, mailForm({ mode: 'reply_all', to: [{ email: 'client@example.com' }], html: '<p>Tuesday works.</p>' }));
  const outReply = fakeMail.state.sent.at(-1);
  check('Outlook reply all stays in the conversation', r.status === 201 && r.data.kind === 'reply_all' && outReply.replyOf === out.messageId && outReply.message.conversationId === out.threadId, { data: r.data, outReply });
  r = await owner('GET', '/mail/inbox');
  check('each person only reads their own inbox', !(r.data.threads || []).some((t) => t.id === out.threadId));

  // Invoice: send from my email
  r = await owner('POST', '/invoices', { customerId: custA, items: [{ description: 'Mail test', quantity: 1, unitPrice: 25000 }] });
  const mailInvoice = r.data.id;
  r = await owner('GET', `/invoices/${mailInvoice}/email-draft`);
  check('invoice email draft: customer, subject and the view link', r.data.to?.[0]?.email === zenithEmail && /Invoice INV-/.test(r.data.subject) && /\/i\//.test(r.data.html), r.data);
  const draft = r.data;
  r = await owner('GET', `/invoices/${mailInvoice}`);
  check('…but the invoice is not marked sent until the email goes', r.data.status === 'draft', r.data.status);
  r = await owner('POST', '/mail/send', mailForm({ to: draft.to, subject: draft.subject, html: draft.html, invoiceId: mailInvoice, customerId: draft.customerId }));
  const inv = await owner('GET', `/invoices/${mailInvoice}`);
  check('sent from my email → invoice marked sent and the email is on it', r.status === 201 && r.data.invoice_id === mailInvoice && inv.data.status === 'sent', { mail: r.data, status: inv.data.status });
  r = await owner('GET', `/mail/sent?invoiceId=${mailInvoice}`);
  check('the invoice shows its email', r.data.total === 1, r.data);

  // Templates & signature
  r = await owner('POST', '/mail/templates', { name: 'Payment reminder', subject: 'Reminder: {invoice number}', bodyHtml: '<p>Dear {contact name}, {amount due} is due {due date}. — {my name}, {company name}. {unknown gap}</p>', isShared: true });
  const tplId = r.data.id;
  check('shared template saved', r.status === 201 && r.data.is_shared === 1, r.data);
  r = await owner('POST', `/mail/templates/${tplId}/fill`, { invoiceId: mailInvoice });
  check('template gaps filled from the invoice; unknown gaps left as written', r.data.subject?.startsWith('Reminder: INV-') && /₦25,000\.00/.test(r.data.html) && /Ada Fashion House/.test(r.data.html) && /\{unknown gap\}/.test(r.data.html), r.data);
  r = await sup('GET', '/mail/templates');
  check('colleagues see shared templates', r.data.some((t) => t.id === tplId), r.data);
  r = await sup('PUT', `/mail/templates/${tplId}`, { name: 'Hijack', subject: 'x', bodyHtml: '<p>x</p>', isShared: true });
  check('only its creator can change a template', r.status === 403, r.data);
  r = await sup('POST', '/mail/templates', { name: 'My private one', subject: 'Hi', bodyHtml: '<p>Hi</p>' });
  const privateTpl = r.data.id;
  r = await owner('GET', '/mail/templates');
  check('personal templates stay personal', !r.data.some((t) => t.id === privateTpl), r.data);
  r = await owner('PUT', '/mail/account/signature', { signatureHtml: '<p><strong>Ada Okafor</strong><br>CEO</p><script>x()</script>' });
  check('signature saved and cleaned', r.status === 200 && /Ada Okafor/.test(r.data.account.signatureHtml) && !/script/.test(r.data.account.signatureHtml), r.data.account);
  r = await owner('POST', '/mail/send', mailForm({ to: [{ email: 'outsider@example.com' }], subject: 'Signed', html: '<p>Body</p>' }));
  check('the signature is added to new emails', /Body<\/p><p><\/p><p><strong>Ada Okafor/.test(r.data.body_html), r.data.body_html);

  // Disconnect
  r = await owner('DELETE', '/mail/account');
  const [[gone]] = await pool.query('SELECT COUNT(*) AS n FROM mail_accounts WHERE email = ?', [ownerWork]);
  check('disconnect removes the mailbox and its tokens', r.data.account === null && Number(gone.n) === 0, r.data);
  r = await owner('GET', `/mail/sent/${sentId}`);
  check('…the record of sent emails stays', r.status === 200 && r.data.id === sentId);
  await sup('DELETE', '/mail/account');

  console.log('\nWorkard super admin');
  const { addAdmin } = await import('../src/services/adminAuthService.js');
  const adminEmail = `admin${stamp}@workard.test`;
  const made = await addAdmin({ userId: null, userName: 'Workard setup' }, { email: adminEmail, fullName: 'Tobi Admin' });
  const setupToken = made.setupLink?.split('/admin/setup/')[1];
  check('the first admin gets a set-your-password link (emailed too)', setupToken && lastEmail(adminEmail)?.text.includes(setupToken), made);
  const admin = client();
  r = await admin('GET', `/admin/auth/setup/${setupToken}`);
  check('the setup link shows who it’s for', r.status === 200 && r.data.email === adminEmail, r.data);
  r = await admin('POST', `/admin/auth/setup/${setupToken}`, { password: 'adminpass123' });
  check('set the password', r.status === 200, r.data);
  r = await admin('POST', `/admin/auth/setup/${setupToken}`, { password: 'again12345' });
  check('…and the link only works once', r.status === 404);

  r = await anon('POST', '/admin/auth/login', { email: freeEmail, password: 'secret123' });
  check('a company owner can’t log in to the admin area', r.status === 401, r.data);
  r = await admin('POST', '/admin/auth/login', { email: adminEmail, password: 'wrong-pass' });
  check('wrong admin password is refused', r.status === 401);
  r = await admin('POST', '/admin/auth/login', { email: adminEmail, password: 'adminpass123' });
  check('admin log-in asks for an emailed code', r.data.requiresOtp && r.data.purpose === 'admin', r.data);
  r = await admin('POST', '/admin/auth/verify', { challengeToken: r.data.challengeToken, code: codeFor(adminEmail) });
  check('code → admin session', r.status === 200 && r.data.admin.email === adminEmail, r.data);
  r = await freeCo('GET', '/admin/overview');
  check('a company session can’t open the admin API', r.status === 401);

  r = await admin('GET', '/admin/overview');
  check('overview: companies, statuses, sign-ups, revenue', r.status === 200 && r.data.totals.companies >= 3 && r.data.byStatus && Array.isArray(r.data.signupsByWeek) && 'monthlyRevenueKobo' in r.data, r.data.totals);

  r = await admin('GET', `/admin/companies?search=${encodeURIComponent(freeEmail)}`);
  const freeCoRow = r.data.companies?.[0];
  check('find a company by its owner’s email', r.data.total === 1 && freeCoRow.name === 'Free Co' && freeCoRow.status === 'trial', r.data);
  const freeOrgId = freeCoRow.id;
  r = await admin('GET', `/admin/companies/${freeOrgId}`);
  check('company page: owner, plan, usage counts — not their records', r.status === 200 && r.data.owner.email === freeEmail && typeof r.data.usage.customers === 'number' && !('employeesList' in r.data), r.data.usage);
  r = await admin('GET', '/admin/companies?status=trial');
  check('filter companies by status', r.data.companies.every((c) => c.status === 'trial') && r.data.counts.trial >= 1, r.data.counts);

  const trialEndBefore = freeCoRow.periodEnd;
  r = await admin('POST', `/admin/companies/${freeOrgId}/extend-trial`, { days: 10 });
  check('extend a trial', r.status === 200 && r.data.periodEnd === addDaysIso(trialEndBefore, 10) && r.data.status === 'trial', r.data);
  r = await freeCo('GET', '/organization/audit-logs');
  check('…and the company sees it in its activity log', r.data.some((l) => l.action === 'workard.trial_extended'), r.data.slice(0, 3));
  r = await admin('POST', `/admin/companies/${freeOrgId}/plan`, { plan: 'business', interval: 'monthly', periodEnd: addDaysIso(todayIso, 60) });
  check('give a plan without payment (free months)', r.data.status === 'active' && r.data.plan === 'business' && r.data.periodEnd === addDaysIso(todayIso, 60), r.data);
  r = await freeCo('GET', '/auth/me');
  check('…the company is on it straight away', r.data.subscription.plan === 'business' && r.data.subscription.status === 'active', r.data.subscription);
  r = await admin('POST', `/admin/companies/${freeOrgId}/exempt`, { exempt: true });
  check('exempt a company from billing', r.data.status === 'exempt');
  r = await admin('POST', `/admin/companies/${freeOrgId}/exempt`, { exempt: false });

  r = await admin('POST', `/admin/companies/${freeOrgId}/suspend`, { reason: 'x' });
  check('suspending needs a reason', r.status === 422);
  r = await admin('POST', `/admin/companies/${freeOrgId}/suspend`, { reason: 'Payment dispute — call us' });
  check('suspend a company (the owner is emailed why)', r.data.status === 'suspended' && /suspended/.test(lastEmail(freeEmail)?.subject), lastEmail(freeEmail)?.subject);
  r = await freeCo('GET', '/employees');
  check('…nobody in it can use Workard', r.status === 423 && r.data.code === 'ORGANIZATION_SUSPENDED' && /Payment dispute/.test(r.data.message), r.data);
  r = await admin('POST', `/admin/companies/${freeOrgId}/restore`);
  check('lift the suspension', r.data.status !== 'suspended' && (await freeCo('GET', '/employees')).status === 200 && /back on Workard/.test(lastEmail(freeEmail)?.subject));

  r = await admin('GET', `/admin/users?search=${encodeURIComponent(freeEmail)}`);
  const freeUser = r.data[0];
  check('find a user and the companies they’re in', freeUser?.email === freeEmail && freeUser.memberships[0].orgName === 'Free Co', r.data);
  r = await admin('POST', `/admin/users/${freeUser.id}/lock`, { locked: true });
  check('lock a user: logged out at once', r.status === 200 && (await freeCo('GET', '/auth/me')).status === 401);
  r = await anon('POST', '/auth/login', { email: freeEmail, password: 'secret123' });
  check('…and they can’t log in', r.status === 403 && /locked/.test(r.data.message), r.data);
  await admin('POST', `/admin/users/${freeUser.id}/lock`, { locked: false });
  r = await freeCo('POST', '/auth/login', { email: freeEmail, password: 'secret123' });
  r = await freeCo('POST', '/auth/verify-otp', { challengeToken: r.data.challengeToken, code: codeFor(freeEmail) });
  check('unlocked: they can log in again', r.status === 200, r.data);
  r = await admin('POST', `/admin/users/${freeUser.id}/reset`);
  check('email someone a password-reset link', r.status === 200 && lastEmail(freeEmail)?.text.includes('/forgot-password?email='), lastEmail(freeEmail)?.text);

  // Support access: only when the OWNER opens it, read-only
  r = await admin('POST', `/admin/companies/${freeOrgId}/support`);
  check('support can’t look inside a company without the owner’s OK', r.status === 403, r.data);
  r = await staff('POST', '/support-access', { hours: 1 });
  check('only the owner can let support in', r.status === 403 || r.status === 401);
  r = await freeCo('POST', '/support-access', { hours: 5 });
  check('only 1, 4, 24 or 72 hours', r.status === 422);
  r = await freeCo('POST', '/support-access', { hours: 1, reason: 'Payroll question' });
  check('owner opens support access for an hour', r.status === 200 && r.data.active, r.data);
  r = await admin('GET', `/admin/companies/${freeOrgId}`);
  check('…the admin sees it’s open', r.data.supportAccess?.reason === 'Payroll question', r.data.supportAccess);
  const supportVisit = client();
  r = await supportVisit('POST', '/admin/auth/login', { email: adminEmail, password: 'adminpass123' });
  await new Promise((done) => setTimeout(done, 10));
  r = await supportVisit('POST', '/admin/auth/verify', { challengeToken: r.data.challengeToken, code: codeFor(adminEmail) });
  r = await supportVisit('POST', `/admin/companies/${freeOrgId}/support`);
  check('admin opens the company (read-only)', r.status === 200 && r.data.endsAt, r.data);
  r = await supportVisit('GET', '/auth/me');
  check('…sees the company as “Workard support”', r.status === 200 && r.data.organization.id === freeOrgId && r.data.support && /support/i.test(r.data.role.name), r.data);
  r = await supportVisit('GET', '/employees');
  check('…can read', r.status === 200);
  r = await supportVisit('POST', '/organization/branches', { name: 'Sneaky branch' });
  check('…but can’t change anything', r.status === 403 && /read-only/.test(r.data.message), r.data);
  r = await freeCo('GET', '/notifications');
  check('the owner is told support is looking', r.data.items.some((n) => n.type === 'support.opened'), r.data.items.map((n) => n.type));
  r = await freeCo('GET', '/support-access');
  check('…and sees each visit', r.data.visits.length === 1, r.data.visits);
  await freeCo('DELETE', '/support-access');
  r = await supportVisit('GET', '/employees');
  check('closing access ends the visit at once', r.status === 401);

  // Prices & trial length (no deploy)
  r = await admin('GET', '/admin/pricing');
  const defaults = r.data;
  const newPrices = Object.fromEntries(defaults.plans.map((p) => [p.id, { ...p.prices }]));
  newPrices.starter.monthly = 1_800_000;
  newPrices.starter.yearly = 18_000_000;
  r = await admin('PUT', '/admin/pricing', { prices: { ...newPrices, business: { monthly: 100_000, yearly: 9_000_000 } }, trialDays: 14 });
  check('a yearly price above 12 months is refused', r.status === 422, r.data);
  r = await admin('PUT', '/admin/pricing', { prices: newPrices, trialDays: 21 });
  check('change prices and trial length', r.status === 200 && r.data.plans[0].prices.monthly === 1_800_000 && r.data.trialDays === 21, r.data);
  r = await anon('GET', '/site/plans');
  check('…the website shows the new price at once', r.data.plans.find((p) => p.id === 'starter').prices.monthly === 1_800_000 && r.data.trialDays === 21, r.data);
  r = await freeCo('GET', '/billing');
  check('…and new payments use it', r.data.plans.find((p) => p.id === 'starter').prices.monthly === 1_800_000, r.data.plans?.[0]);
  r = await admin('DELETE', '/admin/pricing');
  check('reset to the defaults', r.data.plans[0].prices.monthly === defaults.plans[0].defaults.monthly && r.data.trialDays === defaults.defaultTrialDays, r.data);

  // Announcements to owners, demo requests
  r = await admin('POST', '/admin/announcements', { title: 'Maintenance on Saturday', body: 'Workard will be down for 30 minutes at 10pm.', audience: 'all', sendEmail: true });
  check('announce to every company owner', r.status === 201 && r.data.sentTo >= 3, r.data);
  r = await freeCo('GET', '/notifications');
  check('…owners get it in the bell (and by email)', r.data.items.some((n) => n.type === 'workard.announcement') && lastEmail(freeEmail)?.subject === 'Maintenance on Saturday');
  r = await anon('POST', '/site/demo-requests', { fullName: 'Kemi Adeyemi', email: `kemi${stamp}@test.ng`, company: 'Kemi Foods', companySize: '11-50', message: 'We have 3 branches' });
  check('anyone can ask for a demo on the website', r.status === 201, r.data);
  check('…super admins are emailed', /demo request/i.test(lastEmail(adminEmail)?.subject || ''), lastEmail(adminEmail)?.subject);
  r = await anon('POST', '/site/demo-requests', { fullName: 'Bot', email: `bot${stamp}@test.ng`, website: 'spam.com' });
  check('bots filling the hidden field are ignored', r.status === 422 || r.status === 201);
  r = await admin('GET', '/admin/demos');
  const demo = r.data.find((d) => d.email === `kemi${stamp}@test.ng`);
  check('demo requests inbox', demo?.status === 'new' && !r.data.some((d) => d.email === `bot${stamp}@test.ng`), r.data.map((d) => d.email));
  r = await admin('PATCH', `/admin/demos/${demo.id}`, { status: 'contacted', note: 'Called — demo Tuesday' });
  check('mark a request contacted, with a note', r.data.status === 'contacted' && r.data.note === 'Called — demo Tuesday');

  // More super admins — all the same rights
  r = await admin('POST', '/admin/admins', { fullName: 'Chidi Eze', email: staffEmail });
  check('an existing user can be made a super admin (keeps their password)', r.status === 201 && r.data.setupLink === null, r.data);
  r = await admin('GET', '/admin/admins');
  check('list of super admins', r.data.length >= 2 && r.data.some((a) => a.email === staffEmail));
  r = await admin('DELETE', `/admin/admins/${made.userId}`);
  check('you can’t remove yourself', r.status === 409);
  const chidiAdminId = (await admin('GET', '/admin/admins')).data.find((a) => a.email === staffEmail).user_id;
  r = await admin('DELETE', `/admin/admins/${chidiAdminId}`);
  check('remove a super admin', r.status === 204);
  r = await admin('GET', '/admin/log');
  check('every admin action is logged', ['company.suspended', 'company.trial_extended', 'user.locked', 'pricing.updated', 'support.opened', 'admin.added'].every((a) => r.data.rows.some((l) => l.action === a)), r.data.rows.map((l) => l.action));

  // Blog
  const postTitle = `How to run payroll in Nigeria ${stamp}`;
  const postSlug = `how-to-run-payroll-in-nigeria-${stamp}`;
  r = await admin('POST', '/admin/blog', { title: postTitle, bodyHtml: '<h2>PAYE</h2><p>Hello <script>alert(1)</script><img src="https://example.com/a.png" onerror="x()"></p>', category: 'Payroll', status: 'draft' });
  const postId = r.data.id;
  check('write a draft post (HTML is cleaned)', r.status === 201 && r.data.slug === postSlug && r.data.excerpt.startsWith('PAYE Hello') && !/script|onerror/.test(r.data.body_html) && /<img src="https:\/\/example.com\/a.png"/.test(r.data.body_html) && r.data.excerpt, r.data);
  r = await admin('PATCH', `/admin/blog/${postId}`, { bodyHtml: '<div>Line one</div><div>Line two</div>' });
  check('lines typed in the editor stay separate paragraphs', r.data.body_html === '<p>Line one</p><p>Line two</p>', r.data.body_html);
  r = await anon('GET', '/site/blog');
  check('drafts aren’t on the website', !r.data.posts.some((p) => p.id === postId));
  r = await admin('PATCH', `/admin/blog/${postId}`, { status: 'published' });
  check('publish', r.data.status === 'published' && r.data.live === true, r.data);
  r = await anon('GET', '/site/blog');
  check('…it’s on the website, with categories', r.data.posts.some((p) => p.id === postId) && r.data.categories.some((c) => c.name === 'Payroll'), r.data);
  r = await anon('GET', `/site/blog/${postSlug}`);
  check('read a post by its address', r.status === 200 && r.data.post.title === postTitle && r.data.post.readingMinutes >= 1, r.data);
  r = await admin('POST', '/admin/blog', { title: postTitle, bodyHtml: '<p>Part two</p>', status: 'published', publishedAt: new Date(Date.now() + 86400_000).toISOString() });
  const scheduledId = r.data.id;
  check('same title gets its own address; a future date schedules it', r.data.slug === `${postSlug}-2` && r.data.live === false, r.data);
  r = await anon('GET', `/site/blog/${postSlug}-2`);
  check('…scheduled posts aren’t visible yet', r.status === 404);
  r = await anon('GET', '/site/build');
  check('the website build gets every live post + prices', r.data.posts.some((p) => p.post.id === postId) && !r.data.posts.some((p) => p.post.id === scheduledId) && r.data.plans.length === 3);
  r = await admin('DELETE', `/admin/blog/${scheduledId}`);
  check('delete a post', r.status === 204);
  await admin('DELETE', `/admin/blog/${postId}`);
  r = await admin('POST', '/admin/auth/logout');
  r = await admin('GET', '/admin/overview');
  check('admin log out', r.status === 401);

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
  fakeMail.server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
}
