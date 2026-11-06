import { pool } from '../config/db.js';

// ============================================================
// Raw numbers for the Team performance page — one row per employee.
// Every query takes the list of employee ids already filtered by the viewer's scope.
// ============================================================

// Tasks per person in [from, to] (a task with several people counts for each of them):
//   done      completed in the period
//   onTime    … of those, finished on or before the due date (or no due date)
//   overdue   still open, and the due date passed inside the period
export async function taskCounts(orgId, ids, from, to, lastMissedDay, db = pool) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT ta.employee_id,
            SUM(t.status = 'done' AND DATE(t.completed_at) BETWEEN ? AND ?) AS done,
            SUM(t.status = 'done' AND DATE(t.completed_at) BETWEEN ? AND ?
                AND (t.due_date IS NULL OR DATE(t.completed_at) <= t.due_date)) AS on_time,
            SUM(t.status IN ('todo','in_progress') AND t.due_date BETWEEN ? AND ?) AS overdue
       FROM task_assignees ta
       JOIN tasks t ON t.id = ta.task_id
      WHERE t.organization_id = ? AND ta.employee_id IN (?) AND t.status <> 'cancelled'
      GROUP BY ta.employee_id`,
    [from, to, from, to, from, lastMissedDay, orgId, ids]
  );
  return rows;
}

// Average manager score (out of 5) of finished reviews whose period ends in [from, to]
export async function reviewScores(orgId, ids, from, to, db = pool) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT employee_id, AVG(overall_score) AS score, COUNT(*) AS reviews
       FROM reviews
      WHERE organization_id = ? AND employee_id IN (?) AND status IN ('acknowledgement','completed')
        AND overall_score IS NOT NULL AND period_end BETWEEN ? AND ?
      GROUP BY employee_id`,
    [orgId, ids, from, to]
  );
  return rows;
}

// Leads/prospects that became customers in [from, to], credited to whoever handles the account
export async function dealsWon(orgId, ids, from, to, db = pool) {
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT c.assigned_employee_id AS employee_id, COUNT(DISTINCT c.id) AS won
       FROM customer_stage_changes s
       JOIN customers c ON c.id = s.customer_id
      WHERE s.organization_id = ? AND s.to_stage = 'customer' AND s.from_stage IS NOT NULL
        AND DATE(s.changed_at) BETWEEN ? AND ? AND c.assigned_employee_id IN (?)
      GROUP BY c.assigned_employee_id`,
    [orgId, from, to, ids]
  );
  return rows;
}
