import { Router } from 'express';
import authRoutes from './authRoutes.js';
import inviteRoutes from './inviteRoutes.js';
import meRoutes from './meRoutes.js';
import dashboardRoutes from './dashboardRoutes.js';
import employeeRoutes from './employeeRoutes.js';
import documentRoutes from './documentRoutes.js';
import attendanceRoutes from './attendanceRoutes.js';
import leaveRoutes from './leaveRoutes.js';
import organizationRoutes from './organizationRoutes.js';
import roleRoutes from './roleRoutes.js';
import customerRoutes from './customerRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import financeRoutes from './financeRoutes.js';
import publicRoutes from './publicRoutes.js';
import payrollRoutes from './payrollRoutes.js';
import taskRoutes from './taskRoutes.js';
import reviewRoutes from './reviewRoutes.js';
import performanceRoutes from './performanceRoutes.js';
import jobRoutes from './jobRoutes.js';
import billingRoutes from './billingRoutes.js';
import onboardingRoutes from './onboardingRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import announcementRoutes from './announcementRoutes.js';
import staffRequestRoutes from './staffRequestRoutes.js';
import resourceRoutes from './resourceRoutes.js';
import projectRoutes from './projectRoutes.js';
import meetingRoutes from './meetingRoutes.js';

// Every API route, in one place. All of these sit under /api
const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.use('/auth', authRoutes); //            sign up, log in, 2FA codes, password reset
router.use('/invites', inviteRoutes); //       accept an invitation (public)
router.use('/me', meRoutes); //                clock in/out, my leave (self-service)
router.use('/dashboard', dashboardRoutes);
router.use('/employees', employeeRoutes); //   + documents, invites, roles per employee
router.use('/documents', documentRoutes);
router.use('/attendance', attendanceRoutes); // register + flagged clock-ins
router.use('/leave', leaveRoutes); //           approvals
router.use('/organization', organizationRoutes); // branches, departments, teams, leave types
router.use('/roles', roleRoutes);

// Phase 2
router.use('/customers', customerRoutes); //    CRM: customers, activity, follow-ups, cases
router.use('/invoices', invoiceRoutes); //      invoices, payments, invoice settings
router.use('/finance', financeRoutes); //       income, expenses, monthly report
router.use('/public', publicRoutes); //         customer-facing invoice link (no login)

// Phase 3
router.use('/payroll', payrollRoutes); //       salaries, payroll runs, payslips, Paystack
// (the Paystack webhook is in app.js — it needs the raw request body)

// Phase 3B
router.use('/tasks', taskRoutes); //           tasks, checklists, comments, files, repeating tasks
router.use('/reviews', reviewRoutes); //       performance reviews, criteria, review settings
router.use('/performance', performanceRoutes); // team performance charts (CEO / manager view)
router.use('/jobs', jobRoutes); //             daily jobs trigger for an outside cron (CRON_SECRET)

// Plans & onboarding
router.use('/billing', billingRoutes); //       plans, paying the yearly subscription (Paystack)
router.use('/onboarding', onboardingRoutes); // new-joiner checklists

// Working together
router.use('/notifications', notificationRoutes); // the bell
router.use('/announcements', announcementRoutes); // posts to a group + comments
router.use('/requests', staffRequestRoutes); //     salary advances, loans, feedback & complaints
router.use('/resources', resourceRoutes); //       team materials: documents & files
router.use('/projects', projectRoutes); //         projects: tasks for a group, with a board
router.use('/meetings', meetingRoutes); //         meetings & stand-ups (video by LiveKit)

export default router;
