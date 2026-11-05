import * as salesModel from '../models/salesModel.js';
import * as customerModel from '../models/customerModel.js';
import { scopeCondition } from '../utils/scope.js';
import { toDateString, lastMonths } from '../utils/dates.js';

// ============================================================
// SALES DASHBOARD
//   pipeline  → how many customers are in each stage right now
//   funnel    → of everyone who came in as a lead in the period: how many became
//               prospects, how many became customers, how many were lost
//   months    → new leads, won and lost per month
//   winRate   → won ÷ (won + lost) — deals still open don't count either way
//   sources   → which lead sources turn into customers
// Only the customers in the viewer's customers.view scope are counted.
// ============================================================
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

export async function getSales(auth, scope, monthCount = 6) {
  const condition = scopeCondition(scope, auth.employee);
  const months = lastMonths(toDateString().slice(0, 7), monthCount);
  const from = `${months[0]}-01`;

  const [pipeline, newLeads, outcomes, cohort] = await Promise.all([
    customerModel.countByStage(auth.orgId, condition),
    salesModel.newLeadsByMonth(auth.orgId, condition, from),
    salesModel.outcomesByMonth(auth.orgId, condition, from),
    salesModel.pipelineCohort(auth.orgId, condition, from),
  ]);

  // ---------- per month ----------
  const byMonth = months.map((month) => {
    const won = outcomes.find((o) => o.month === month && o.outcome === 'customer');
    const lost = outcomes.find((o) => o.month === month && o.outcome === 'lost');
    return {
      month,
      newLeads: Number(newLeads.find((n) => n.month === month)?.total || 0),
      won: Number(won?.total || 0),
      lost: Number(lost?.total || 0),
    };
  });
  const won = byMonth.reduce((s, m) => s + m.won, 0);
  const lost = byMonth.reduce((s, m) => s + m.lost, 0);
  const wins = outcomes.filter((o) => o.outcome === 'customer');
  const winDays = wins.reduce((s, o) => s + Number(o.avg_days) * Number(o.total), 0);

  // ---------- funnel (everyone who came in as a lead in the period) ----------
  const funnel = {
    leads: cohort.length,
    prospects: cohort.filter((c) => c.reached_prospect).length,
    customers: cohort.filter((c) => c.reached_customer).length,
    lost: cohort.filter((c) => c.stage === 'lost').length,
    open: cohort.filter((c) => ['lead', 'prospect'].includes(c.stage)).length,
  };

  // ---------- lead sources ----------
  const sources = new Map();
  for (const c of cohort) {
    const s = sources.get(c.source) || { source: c.source, leads: 0, customers: 0, lost: 0 };
    s.leads += 1;
    if (c.reached_customer) s.customers += 1;
    if (c.stage === 'lost') s.lost += 1;
    sources.set(c.source, s);
  }

  return {
    months: byMonth,
    from,
    pipeline: { lead: 0, prospect: 0, customer: 0, lost: 0, inactive: 0, ...pipeline },
    funnel,
    conversion: percent(funnel.customers, funnel.leads), // lead → customer
    totals: { newLeads: byMonth.reduce((s, m) => s + m.newLeads, 0), won, lost },
    winRate: percent(won, won + lost),
    avgDaysToWin: wins.length ? Math.round(winDays / won) : null,
    sources: [...sources.values()]
      .map((s) => ({ ...s, conversion: percent(s.customers, s.leads) }))
      .sort((a, b) => b.leads - a.leads),
  };
}

// A customer's journey through the stages (shown on their profile)
export async function stageHistory(customerId) {
  return salesModel.historyFor(customerId);
}
