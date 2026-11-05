import { pool } from '../config/db.js';

// ============================================================
// Sales pipeline: stage history + the numbers for the sales dashboard.
// Every query takes a scope condition built on alias "e" (the ASSIGNED employee),
// so a sales rep only sees their own pipeline, a manager their team's, etc.
// ============================================================

// Write one stage change (from_stage is null when the customer is first added)
export async function recordChange({ orgId, customerId, fromStage, toStage, changedBy }, db = pool) {
  await db.query(
    `INSERT INTO customer_stage_changes (organization_id, customer_id, from_stage, to_stage, changed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, customerId, fromStage || null, toStage, changedBy || null]
  );
}

export async function historyFor(customerId, db = pool) {
  const [rows] = await db.query(
    `SELECT h.from_stage, h.to_stage, h.changed_at, u.full_name AS changed_by_name
       FROM customer_stage_changes h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.customer_id = ? ORDER BY h.changed_at, h.id`,
    [customerId]
  );
  return rows;
}

const FROM_CUSTOMERS = 'FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id';

// New leads per month: customers added as a lead or prospect (not added straight in as a customer)
export async function newLeadsByMonth(orgId, scope, from, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS month, COUNT(*) AS total
       ${FROM_CUSTOMERS}
       JOIN customer_stage_changes h ON h.customer_id = c.id AND h.from_stage IS NULL
      WHERE c.organization_id = ? AND ${scope.sql} AND c.created_at >= ? AND h.to_stage IN ('lead','prospect')
      GROUP BY month`,
    [orgId, ...scope.params, from]
  );
  return rows;
}

// Won (moved to customer) and lost (moved to lost) per month
export async function outcomesByMonth(orgId, scope, from, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(h.changed_at, '%Y-%m') AS month, h.to_stage AS outcome, COUNT(*) AS total,
            AVG(DATEDIFF(h.changed_at, c.created_at)) AS avg_days
       FROM customer_stage_changes h
       JOIN customers c ON c.id = h.customer_id
       LEFT JOIN employees e ON e.id = c.assigned_employee_id
      WHERE h.organization_id = ? AND ${scope.sql} AND h.changed_at >= ?
        AND h.from_stage IS NOT NULL AND h.to_stage IN ('customer','lost')
      GROUP BY month, outcome`,
    [orgId, ...scope.params, from]
  );
  return rows;
}

// Everyone who entered the pipeline (as a lead or prospect) since `from`, with how far they got
export async function pipelineCohort(orgId, scope, from, db = pool) {
  const [rows] = await db.query(
    `SELECT c.id, c.stage, COALESCE(NULLIF(c.source, ''), 'Not recorded') AS source,
            EXISTS (SELECT 1 FROM customer_stage_changes x WHERE x.customer_id = c.id AND x.to_stage IN ('prospect','customer')) AS reached_prospect,
            EXISTS (SELECT 1 FROM customer_stage_changes x WHERE x.customer_id = c.id AND x.to_stage = 'customer') AS reached_customer
       ${FROM_CUSTOMERS}
       JOIN customer_stage_changes h ON h.customer_id = c.id AND h.from_stage IS NULL
      WHERE c.organization_id = ? AND ${scope.sql} AND c.created_at >= ? AND h.to_stage IN ('lead','prospect')`,
    [orgId, ...scope.params, from]
  );
  return rows;
}

// Customers with no history yet (added before history was kept): one starting row each
export async function backfill(orgId, db = pool) {
  const [result] = await db.query(
    `INSERT INTO customer_stage_changes (organization_id, customer_id, from_stage, to_stage, changed_by, changed_at)
     SELECT c.organization_id, c.id, NULL, c.stage, c.created_by, c.created_at
       FROM customers c
      WHERE c.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM customer_stage_changes h WHERE h.customer_id = c.id)`,
    [orgId]
  );
  return result.affectedRows;
}
