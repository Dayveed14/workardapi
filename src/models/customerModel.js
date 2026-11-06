import { pool } from '../config/db.js';
import { recordChange } from './salesModel.js';

// Columns a form can set (camelCase → snake_case)
const EDITABLE = {
  type: 'type',
  name: 'name',
  contactPerson: 'contact_person',
  email: 'email',
  phone: 'phone',
  address: 'address',
  stage: 'stage',
  source: 'source',
  assignedEmployeeId: 'assigned_employee_id',
  notes: 'notes',
};

// Customer + who it's assigned to + money owed / paid.
// "e" is the ASSIGNED employee — the permission scope is applied to it.
const SELECT_CUSTOMER = `
  SELECT c.*,
         CONCAT(e.first_name, ' ', e.last_name) AS assigned_name,
         ab.full_name AS assigned_by_name,
         (SELECT COALESCE(SUM(i.total_kobo - i.amount_paid_kobo), 0) FROM invoices i
           WHERE i.customer_id = c.id AND i.status IN ('sent','partially_paid')) AS balance_kobo,
         (SELECT COALESCE(SUM(p.amount_kobo), 0) FROM invoice_payments p WHERE p.customer_id = c.id) AS lifetime_paid_kobo,
         (SELECT MAX(ci.created_at) FROM customer_interactions ci WHERE ci.customer_id = c.id) AS last_activity_at
    FROM customers c
    LEFT JOIN employees e ON e.id = c.assigned_employee_id
    LEFT JOIN users ab ON ab.id = c.assigned_by`;

export async function create(orgId, data, db = pool) {
  const columns = ['organization_id', 'created_by'];
  const values = [orgId, data.createdBy || null];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      columns.push(column);
      values.push(data[key] === '' ? null : data[key]);
    }
  }
  const [result] = await db.query(
    `INSERT INTO customers (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values
  );
  return result.insertId;
}

export async function update(orgId, id, data, db = pool) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(data[key] === '' ? null : data[key]);
    }
  }
  if (!sets.length) return;
  await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE organization_id = ? AND id = ?`, [...values, orgId, id]);
}

// Customers someone else gave to this employee, newest first (dashboard "Assigned to you")
export async function listAssignedByOthers(orgId, employeeId, userId, limit = 5, db = pool) {
  const [rows] = await db.query(
    `${SELECT_CUSTOMER}
      WHERE c.organization_id = ? AND c.assigned_employee_id = ? AND c.assigned_by IS NOT NULL AND c.assigned_by <> ?
        AND c.stage IN ('lead','prospect','customer')
      ORDER BY c.assigned_at DESC LIMIT ?`,
    [orgId, employeeId, userId, limit]
  );
  return rows;
}

// Who handles the customer now, and who gave it to them
export async function setAssignment(orgId, id, employeeId, byUserId, db = pool) {
  await db.query(
    'UPDATE customers SET assigned_employee_id = ?, assigned_by = ?, assigned_at = NOW() WHERE organization_id = ? AND id = ?',
    [employeeId, byUserId, orgId, id]
  );
}

// Move a customer to a new stage and keep the history (does nothing if it's already there)
export async function setStage(orgId, id, toStage, changedBy, db = pool) {
  const [rows] = await db.query('SELECT stage FROM customers WHERE organization_id = ? AND id = ?', [orgId, id]);
  const fromStage = rows[0]?.stage;
  if (!fromStage || fromStage === toStage) return false;
  await db.query('UPDATE customers SET stage = ? WHERE organization_id = ? AND id = ?', [toStage, orgId, id]);
  await recordChange({ orgId, customerId: id, fromStage, toStage, changedBy }, db);
  return true;
}

// One customer, only if inside the scope condition (built on alias "e")
export async function findInScope(orgId, id, scope, db = pool) {
  const [rows] = await db.query(`${SELECT_CUSTOMER} WHERE c.organization_id = ? AND c.id = ? AND ${scope.sql}`, [
    orgId,
    id,
    ...scope.params,
  ]);
  return rows[0] || null;
}

export async function findById(orgId, id, db = pool) {
  return findInScope(orgId, id, { sql: '1=1', params: [] }, db);
}

export async function list(orgId, scope, { search, stage, assignedEmployeeId, limit, offset }, db = pool) {
  const where = ['c.organization_id = ?', scope.sql];
  const params = [orgId, ...scope.params];

  if (search) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.contact_person LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (stage) {
    where.push('c.stage = ?');
    params.push(stage);
  }
  if (assignedEmployeeId) {
    where.push('c.assigned_employee_id = ?');
    params.push(assignedEmployeeId);
  }

  const whereSql = where.join(' AND ');
  const [rows] = await db.query(`${SELECT_CUSTOMER} WHERE ${whereSql} ORDER BY c.name LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  const [count] = await db.query(
    `SELECT COUNT(*) AS total FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id WHERE ${whereSql}`,
    params
  );
  return { rows, total: Number(count[0].total) };
}

// Small list for the "choose customer" dropdown on invoices
export async function options(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT id, name, email, phone FROM customers WHERE organization_id = ? AND stage <> 'inactive' ORDER BY name`,
    [orgId]
  );
  return rows;
}

// For the dashboard
export async function countByStage(orgId, scope, db = pool) {
  const [rows] = await db.query(
    `SELECT c.stage, COUNT(*) AS total
       FROM customers c LEFT JOIN employees e ON e.id = c.assigned_employee_id
      WHERE c.organization_id = ? AND ${scope.sql}
      GROUP BY c.stage`,
    [orgId, ...scope.params]
  );
  return Object.fromEntries(rows.map((r) => [r.stage, Number(r.total)]));
}
