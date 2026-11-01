import { pool } from '../config/db.js';

// ---------- Categories ----------
export async function listCategories(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT fc.*, (SELECT COUNT(*) FROM finance_entries fe WHERE fe.category_id = fc.id) AS entry_count
       FROM finance_categories fc WHERE fc.organization_id = ? ORDER BY fc.type, fc.name`,
    [orgId]
  );
  return rows;
}

export async function findCategory(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM finance_categories WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function createCategory(orgId, { type, name }, db = pool) {
  const [result] = await db.query('INSERT INTO finance_categories (organization_id, type, name) VALUES (?, ?, ?)', [
    orgId,
    type,
    name,
  ]);
  return result.insertId;
}

export async function updateCategory(orgId, id, { name, isActive }, db = pool) {
  await db.query('UPDATE finance_categories SET name = ?, is_active = ? WHERE organization_id = ? AND id = ?', [
    name,
    isActive ? 1 : 0,
    orgId,
    id,
  ]);
}

// ---------- Entries (other income & expenses) ----------
const SELECT_ENTRY = `
  SELECT fe.*, fc.name AS category_name, u.full_name AS recorded_by_name
    FROM finance_entries fe
    JOIN finance_categories fc ON fc.id = fe.category_id
    LEFT JOIN users u ON u.id = fe.recorded_by`;

export async function createEntry(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO finance_entries
       (organization_id, type, category_id, amount_kobo, entry_date, description, party, method, reference, request_id, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      data.type,
      data.categoryId,
      data.amountKobo,
      data.entryDate,
      data.description,
      data.party || null,
      data.method,
      data.reference || null,
      data.requestId || null,
      data.recordedBy || null,
    ]
  );
  return result.insertId;
}

export async function findEntry(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_ENTRY} WHERE fe.organization_id = ? AND fe.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function findEntryByRequestId(orgId, requestId, db = pool) {
  const [rows] = await db.query(`${SELECT_ENTRY} WHERE fe.organization_id = ? AND fe.request_id = ?`, [orgId, requestId]);
  return rows[0] || null;
}

export async function listEntries(orgId, { from, to, type, categoryId }, db = pool) {
  const where = ['fe.organization_id = ?', 'fe.entry_date BETWEEN ? AND ?'];
  const params = [orgId, from, to];
  if (type) {
    where.push('fe.type = ?');
    params.push(type);
  }
  if (categoryId) {
    where.push('fe.category_id = ?');
    params.push(categoryId);
  }
  const [rows] = await db.query(`${SELECT_ENTRY} WHERE ${where.join(' AND ')} ORDER BY fe.entry_date DESC, fe.id DESC`, params);
  return rows;
}

export async function setReceipt(id, { url, publicId, resourceType }, db = pool) {
  await db.query('UPDATE finance_entries SET receipt_url = ?, receipt_public_id = ?, receipt_type = ? WHERE id = ?', [
    url,
    publicId,
    resourceType,
    id,
  ]);
}

export async function removeEntry(id, db = pool) {
  await db.query('DELETE FROM finance_entries WHERE id = ?', [id]);
}

// ---------- Report numbers ----------
// Money received from invoices between two dates
export async function invoicePaymentsTotal(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    'SELECT COALESCE(SUM(amount_kobo), 0) AS total FROM invoice_payments WHERE organization_id = ? AND paid_on BETWEEN ? AND ?',
    [orgId, from, to]
  );
  return Number(rows[0].total);
}

// Totals per category for income or expense
export async function totalsByCategory(orgId, type, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT fc.name, SUM(fe.amount_kobo) AS total
       FROM finance_entries fe JOIN finance_categories fc ON fc.id = fe.category_id
      WHERE fe.organization_id = ? AND fe.type = ? AND fe.entry_date BETWEEN ? AND ?
      GROUP BY fc.name ORDER BY total DESC`,
    [orgId, type, from, to]
  );
  return rows.map((r) => ({ name: r.name, totalKobo: Number(r.total) }));
}

// Month-by-month totals between two dates, e.g. { "2026-10": 1500000 }
export async function monthlyInvoicePayments(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(paid_on, '%Y-%m') AS month, SUM(amount_kobo) AS total
       FROM invoice_payments WHERE organization_id = ? AND paid_on BETWEEN ? AND ?
      GROUP BY month`,
    [orgId, from, to]
  );
  return Object.fromEntries(rows.map((r) => [r.month, Number(r.total)]));
}

export async function monthlyEntries(orgId, type, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(entry_date, '%Y-%m') AS month, SUM(amount_kobo) AS total
       FROM finance_entries WHERE organization_id = ? AND type = ? AND entry_date BETWEEN ? AND ?
      GROUP BY month`,
    [orgId, type, from, to]
  );
  return Object.fromEntries(rows.map((r) => [r.month, Number(r.total)]));
}

// Value of invoices issued in the period (not drafts or voided)
export async function invoicedTotal(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(total_kobo), 0) AS total, COUNT(*) AS count FROM invoices
      WHERE organization_id = ? AND status NOT IN ('draft','void') AND issue_date BETWEEN ? AND ?`,
    [orgId, from, to]
  );
  return { totalKobo: Number(rows[0].total), count: Number(rows[0].count) };
}

// Who paid the most in the period
export async function topCustomers(orgId, from, to, limit = 5, db = pool) {
  const [rows] = await db.query(
    `SELECT c.id, c.name, SUM(p.amount_kobo) AS total
       FROM invoice_payments p JOIN customers c ON c.id = p.customer_id
      WHERE p.organization_id = ? AND p.paid_on BETWEEN ? AND ?
      GROUP BY c.id, c.name ORDER BY total DESC LIMIT ?`,
    [orgId, from, to, limit]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, totalKobo: Number(r.total) }));
}
