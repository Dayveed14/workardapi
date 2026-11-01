import { pool } from '../config/db.js';

// ---------- Settings & numbering ----------
export async function createSettings(orgId, db = pool) {
  await db.query('INSERT IGNORE INTO invoice_settings (organization_id) VALUES (?)', [orgId]);
}

export async function getSettings(orgId, db = pool) {
  await createSettings(orgId, db); // older organisations may not have a row yet
  const [rows] = await db.query('SELECT * FROM invoice_settings WHERE organization_id = ?', [orgId]);
  return rows[0];
}

export async function updateSettings(orgId, data, db = pool) {
  await createSettings(orgId, db);
  await db.query(
    `UPDATE invoice_settings SET prefix = ?, default_due_days = ?, default_tax_rate = ?,
            bank_name = ?, account_name = ?, account_number = ?, footer_note = ?
      WHERE organization_id = ?`,
    [
      data.prefix,
      data.defaultDueDays,
      data.defaultTaxRate,
      data.bankName || null,
      data.accountName || null,
      data.accountNumber || null,
      data.footerNote || null,
      orgId,
    ]
  );
}

// Gives out the next invoice number, e.g. "INV-0007".
// MUST run inside a transaction: FOR UPDATE locks the row so two people
// creating invoices at the same moment can never get the same number.
export async function takeNextNumber(orgId, db) {
  const select = 'SELECT prefix, next_number FROM invoice_settings WHERE organization_id = ? FOR UPDATE';
  let [rows] = await db.query(select, [orgId]);
  if (!rows.length) {
    // Very old organisation with no settings row yet (normally created at sign-up / db:sync)
    await createSettings(orgId, db);
    [rows] = await db.query(select, [orgId]);
  }
  const { prefix, next_number: next } = rows[0];
  await db.query('UPDATE invoice_settings SET next_number = next_number + 1 WHERE organization_id = ?', [orgId]);
  return `${prefix}${String(next).padStart(4, '0')}`;
}

// ---------- Invoices ----------
// display_status adds "overdue": unpaid and past the due date
const SELECT_INVOICE = `
  SELECT i.*,
         CASE WHEN i.status IN ('sent','partially_paid') AND i.due_date < ? THEN 'overdue' ELSE i.status END AS display_status,
         (i.total_kobo - i.amount_paid_kobo) AS balance_kobo,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         c.address AS customer_address, c.contact_person AS customer_contact
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id`;

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO invoices
       (organization_id, customer_id, invoice_number, issue_date, due_date, subtotal_kobo, discount_kobo,
        tax_rate, tax_kobo, total_kobo, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.customerId,
      data.invoiceNumber,
      data.issueDate,
      data.dueDate,
      data.subtotalKobo,
      data.discountKobo,
      data.taxRate,
      data.taxKobo,
      data.totalKobo,
      data.notes || null,
      data.createdBy || null,
    ]
  );
  return result.insertId;
}

export async function updateDetails(orgId, id, data, db = pool) {
  await db.query(
    `UPDATE invoices SET customer_id = ?, issue_date = ?, due_date = ?, subtotal_kobo = ?, discount_kobo = ?,
            tax_rate = ?, tax_kobo = ?, total_kobo = ?, notes = ?
      WHERE organization_id = ? AND id = ?`,
    [
      data.customerId,
      data.issueDate,
      data.dueDate,
      data.subtotalKobo,
      data.discountKobo,
      data.taxRate,
      data.taxKobo,
      data.totalKobo,
      data.notes || null,
      orgId,
      id,
    ]
  );
}

// Deletes the old lines and writes the new ones (simplest way to edit lines)
export async function replaceItems(invoiceId, lines, db = pool) {
  await db.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
  for (const [index, line] of lines.entries()) {
    await db.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_kobo, line_total_kobo, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [invoiceId, line.description, line.quantity, line.unitPriceKobo, line.lineTotalKobo, index]
    );
  }
}

export async function getItems(invoiceId, db = pool) {
  const [rows] = await db.query('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id', [invoiceId]);
  return rows;
}

// forUpdate = true locks the invoice row until the transaction ends (used for payments)
export async function findById(orgId, id, today, { forUpdate = false } = {}, db = pool) {
  const [rows] = await db.query(
    `${SELECT_INVOICE} WHERE i.organization_id = ? AND i.id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [today, orgId, id]
  );
  return rows[0] || null;
}

export async function findByToken(token, today, db = pool) {
  const [rows] = await db.query(`${SELECT_INVOICE} WHERE i.public_token = ? AND i.status <> 'void'`, [today, token]);
  return rows[0] || null;
}

// filter: all | draft | unpaid | overdue | paid | void
export async function list(orgId, today, { filter, customerId, search, limit, offset }, db = pool) {
  const where = ['i.organization_id = ?'];
  const params = [orgId];

  if (filter === 'unpaid') where.push(`i.status IN ('sent','partially_paid')`);
  else if (filter === 'overdue') {
    where.push(`i.status IN ('sent','partially_paid') AND i.due_date < ?`);
    params.push(today);
  } else if (filter && filter !== 'all') {
    where.push('i.status = ?');
    params.push(filter);
  }
  if (customerId) {
    where.push('i.customer_id = ?');
    params.push(customerId);
  }
  if (search) {
    where.push('(i.invoice_number LIKE ? OR c.name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereSql = where.join(' AND ');
  const [rows] = await db.query(
    `${SELECT_INVOICE} WHERE ${whereSql} ORDER BY i.issue_date DESC, i.id DESC LIMIT ? OFFSET ?`,
    [today, ...params, limit, offset]
  );
  const [count] = await db.query(
    `SELECT COUNT(*) AS total FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE ${whereSql}`,
    params
  );
  return { rows, total: Number(count[0].total) };
}

// Totals for the cards at the top of the invoices page
export async function summary(orgId, today, db = pool) {
  const [rows] = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent','partially_paid') THEN total_kobo - amount_paid_kobo END), 0) AS outstanding_kobo,
        COALESCE(SUM(CASE WHEN status IN ('sent','partially_paid') AND due_date < ? THEN total_kobo - amount_paid_kobo END), 0) AS overdue_kobo,
        COALESCE(SUM(status IN ('sent','partially_paid')), 0) AS unpaid_count,
        COALESCE(SUM(status IN ('sent','partially_paid') AND due_date < ?), 0) AS overdue_count,
        COALESCE(SUM(status = 'draft'), 0) AS draft_count
       FROM invoices WHERE organization_id = ?`,
    [today, today, orgId]
  );
  const r = rows[0];
  return {
    outstandingKobo: Number(r.outstanding_kobo),
    overdueKobo: Number(r.overdue_kobo),
    unpaidCount: Number(r.unpaid_count),
    overdueCount: Number(r.overdue_count),
    draftCount: Number(r.draft_count),
  };
}

export async function setPaymentState(id, amountPaidKobo, status, db = pool) {
  await db.query('UPDATE invoices SET amount_paid_kobo = ?, status = ? WHERE id = ?', [amountPaidKobo, status, id]);
}

export async function markSent(id, { token, when, status }, db = pool) {
  await db.query('UPDATE invoices SET public_token = COALESCE(public_token, ?), sent_at = COALESCE(sent_at, ?), status = ? WHERE id = ?', [
    token,
    when,
    status,
    id,
  ]);
}

export async function markViewed(id, when, db = pool) {
  await db.query('UPDATE invoices SET viewed_at = ? WHERE id = ? AND viewed_at IS NULL', [when, id]);
}

export async function markVoid(id, when, db = pool) {
  await db.query(`UPDATE invoices SET status = 'void', voided_at = ? WHERE id = ?`, [when, id]);
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM invoices WHERE organization_id = ? AND id = ?', [orgId, id]);
}
