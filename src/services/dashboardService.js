import * as employeeModel from '../models/employeeModel.js';
import * as attendanceModel from '../models/attendanceModel.js';
import * as leaveModel from '../models/leaveModel.js';
import * as customerModel from '../models/customerModel.js';
import * as interactionModel from '../models/interactionModel.js';
import * as invoiceModel from '../models/invoiceModel.js';
import { getSummary } from './financeService.js';
import { getCounts as getTaskCounts } from './taskService.js';
import { countWaiting as countReviewsWaiting } from './reviewService.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString } from '../utils/dates.js';

// The dashboard only counts what the viewer is allowed to see.
// e.g. a Team Supervisor sees numbers for their team only,
// and money only shows for people with finance/invoice permissions.
export async function getDashboard(auth, scope) {
  const today = toDateString();
  const condition = scopeCondition(scope, auth.employee);

  // Approvals use their own permissions (a person may see the dashboard but not approve)
  const leaveScope = auth.permissions['leave.approve'];
  const reviewScope = auth.permissions['attendance.review'];

  const [headcount, attendance, onLeave, byDepartment, recentClockIns, upcomingLeave, pendingLeave] = await Promise.all([
    employeeModel.countActive(auth.orgId, condition),
    attendanceModel.todayStats(auth.orgId, today, condition),
    leaveModel.countOnLeave(auth.orgId, today, condition),
    employeeModel.countByDepartment(auth.orgId, condition),
    attendanceModel.recentClockIns(auth.orgId, today, condition),
    leaveModel.upcoming(auth.orgId, today, condition),
    leaveScope ? leaveModel.countPending(auth.orgId, scopeCondition(leaveScope, auth.employee)) : 0,
  ]);

  const flaggedForMe = reviewScope
    ? (await attendanceModel.listFlaggedPending(auth.orgId, scopeCondition(reviewScope, auth.employee))).length
    : 0;

  return {
    date: today,
    scope,
    headcount,
    today: {
      present: attendance.present,
      late: attendance.late,
      onLeave,
      absent: Math.max(0, headcount - attendance.present - onLeave),
      attendanceRate: headcount ? Math.round((attendance.present / Math.max(1, headcount - onLeave)) * 100) : 0,
    },
    needsAttention: { pendingLeave, flaggedClockIns: flaggedForMe },
    byDepartment,
    recentClockIns,
    upcomingLeave,
    // Phase 2 blocks — only included if the person may see them
    money: await moneyBlock(auth, today),
    customers: await customerBlock(auth, today),
    // Phase 3B — everyone has their own tasks & reviews
    tasks: await getTaskCounts(auth),
    reviews: await countReviewsWaiting(auth),
  };
}

async function moneyBlock(auth, today) {
  if (auth.permissions['finance.view']) {
    const s = await getSummary(auth.orgId, today.slice(0, 7));
    return {
      revenueKobo: s.revenueKobo,
      expensesKobo: s.expensesKobo,
      profitKobo: s.profitKobo,
      outstandingKobo: s.receivables.outstandingKobo,
      overdueKobo: s.receivables.overdueKobo,
      overdueCount: s.receivables.overdueCount,
      trend: s.trend,
    };
  }
  if (auth.permissions['invoices.view']) {
    const r = await invoiceModel.summary(auth.orgId, today);
    return { outstandingKobo: r.outstandingKobo, overdueKobo: r.overdueKobo, overdueCount: r.overdueCount };
  }
  return null;
}

async function customerBlock(auth, today) {
  const scope = auth.permissions['customers.view'];
  if (!scope) return null;
  const condition = scopeCondition(scope, auth.employee);
  const [byStage, followUps, openCases] = await Promise.all([
    customerModel.countByStage(auth.orgId, condition),
    interactionModel.listFollowUps(auth.orgId, condition, today),
    interactionModel.listOpenCases(auth.orgId, condition),
  ]);
  return { byStage, followUpsDue: followUps.length, openCases: openCases.length };
}
