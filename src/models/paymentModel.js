import { pool } from '../config/db.js';

const SELECT_PAYMENT = `
  SELECT p.*, i.invoice_number, c.name AS customer_name, u.full_name AS recorded_by_name
    FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN users u ON u.id = p.recorded_by`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO invoice_payments
       (organization_id, invoice_id, customer_id, amount_kobo, paid_on, method, reference, note, request_id, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.invoiceId,
      data.customerId,
      data.amountKobo,
      data.paidOn,
      data.method,
      data.reference || null,
      data.note || null,
      data.requestId || null,
      data.recordedBy || null,
    ]
  );
  return result.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_PAYMENT} WHERE p.organization_id = ? AND p.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// Used to make "record payment" safe to click twice / retry
export async function findByRequestId(orgId, requestId, db = pool) {
  const [rows] = await db.query(`${SELECT_PAYMENT} WHERE p.organization_id = ? AND p.request_id = ?`, [orgId, requestId]);
  return rows[0] || null;
}

export async function listByInvoice(orgId, invoiceId, db = pool) {
  const [rows] = await db.query(`${SELECT_PAYMENT} WHERE p.organization_id = ? AND p.invoice_id = ? ORDER BY p.paid_on, p.id`, [
    orgId,
    invoiceId,
  ]);
  return rows;
}

export async function listByCustomer(orgId, customerId, db = pool) {
  const [rows] = await db.query(
    `${SELECT_PAYMENT} WHERE p.organization_id = ? AND p.customer_id = ? ORDER BY p.paid_on DESC, p.id DESC`,
    [orgId, customerId]
  );
  return rows;
}

export async function listForMonth(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    `${SELECT_PAYMENT} WHERE p.organization_id = ? AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on DESC, p.id DESC`,
    [orgId, from, to]
  );
  return rows;
}

// The true amount paid, added up from the payments themselves
export async function sumForInvoice(invoiceId, db = pool) {
  const [rows] = await db.query('SELECT COALESCE(SUM(amount_kobo), 0) AS total FROM invoice_payments WHERE invoice_id = ?', [
    invoiceId,
  ]);
  return Number(rows[0].total);
}

export async function remove(id, db = pool) {
  await db.query('DELETE FROM invoice_payments WHERE id = ?', [id]);
}
