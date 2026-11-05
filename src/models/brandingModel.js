import { pool } from '../config/db.js';

// ---------- The business's look on invoices ----------
export async function find(orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM invoice_branding WHERE organization_id = ?', [orgId]);
  return rows[0] || null;
}

async function ensureRow(orgId, db) {
  await db.query('INSERT IGNORE INTO invoice_branding (organization_id) VALUES (?)', [orgId]);
}

export async function updateDetails(orgId, { brandColor, signatoryName, signatoryTitle }, db = pool) {
  await ensureRow(orgId, db);
  await db.query(
    'UPDATE invoice_branding SET brand_color = ?, signatory_name = ?, signatory_title = ? WHERE organization_id = ?',
    [brandColor || null, signatoryName || null, signatoryTitle || null, orgId]
  );
}

// kind: 'logo' | 'signature'  (url = null removes it)
export async function setImage(orgId, kind, url, publicId, db = pool) {
  await ensureRow(orgId, db);
  const column = kind === 'logo' ? 'logo' : 'signature';
  await db.query(`UPDATE invoice_branding SET ${column}_url = ?, ${column}_public_id = ? WHERE organization_id = ?`, [
    url,
    publicId || null,
    orgId,
  ]);
}

// ---------- The customer's acceptance ----------
// INSERT IGNORE: only the first acceptance counts
export async function accept({ invoiceId, orgId, signerName, signatureData, note, ip }, db = pool) {
  const [result] = await db.query(
    `INSERT IGNORE INTO invoice_acceptances (invoice_id, organization_id, signer_name, signature_data, note, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [invoiceId, orgId, signerName, signatureData, note || null, ip || null]
  );
  return result.affectedRows === 1;
}

export async function findAcceptance(invoiceId, db = pool) {
  const [rows] = await db.query('SELECT * FROM invoice_acceptances WHERE invoice_id = ?', [invoiceId]);
  return rows[0] || null;
}
