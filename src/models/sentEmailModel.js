import { pool } from '../config/db.js';

// ============================================================
// The record of emails sent from Workard: sent_emails + recipients + attachments.
//
// WHO CAN SEE AN EMAIL (David's rule): the sender, and Workard users of this company it was
// sent to (to / cc / their own bcc). Nobody else — not managers, not HR, not the owner.
// Every read below goes through VISIBLE, so the rule lives in one place.
// A bcc'd person sees the email but never the other bcc addresses (see listRecipients).
// ============================================================

const VISIBLE = `(se.sender_user_id = ? OR EXISTS (
  SELECT 1 FROM sent_email_recipients vr WHERE vr.email_id = se.id AND vr.user_id = ?))`;

export async function findByRequestId(orgId, requestId, db = pool) {
  if (!requestId) return null;
  const [rows] = await db.query('SELECT * FROM sent_emails WHERE organization_id = ? AND request_id = ?', [orgId, requestId]);
  return rows[0] || null;
}

export async function create(orgId, e, db = pool) {
  const [result] = await db.query(
    `INSERT INTO sent_emails
       (organization_id, sender_user_id, mail_account_id, provider, from_email, from_name, subject, body_html, body_text,
        customer_id, employee_id, invoice_id, kind, provider_thread_id, status, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
    [orgId, e.senderUserId, e.mailAccountId, e.provider, e.fromEmail, e.fromName || null, e.subject, e.bodyHtml, e.bodyText || null,
     e.customerId || null, e.employeeId || null, e.invoiceId || null, e.kind || 'new', e.threadId || null, e.requestId || null, new Date()]
  );
  return result.insertId;
}

// [{ kind, email, name, userId, customerId, employeeId }]
export async function addRecipients(emailId, list, db = pool) {
  if (!list.length) return;
  await db.query(
    'INSERT INTO sent_email_recipients (email_id, kind, email, name, user_id, customer_id, employee_id) VALUES ?',
    [list.map((r) => [emailId, r.kind, r.email, r.name || null, r.userId || null, r.customerId || null, r.employeeId || null])]
  );
}

export async function addAttachments(emailId, list, db = pool) {
  if (!list.length) return;
  await db.query(
    'INSERT INTO sent_email_attachments (email_id, file_name, mime_type, size_bytes, file_url, public_id) VALUES ?',
    [list.map((a) => [emailId, a.fileName, a.mimeType || null, a.size, a.url || null, a.publicId || null])]
  );
}

export async function markSent(id, { messageId, threadId }, db = pool) {
  await db.query(
    "UPDATE sent_emails SET status = 'sent', provider_message_id = ?, provider_thread_id = COALESCE(?, provider_thread_id), sent_at = ?, error = NULL WHERE id = ?",
    [messageId || null, threadId || null, new Date(), id]
  );
}

export async function markFailed(id, error, db = pool) {
  await db.query("UPDATE sent_emails SET status = 'failed', error = ? WHERE id = ?", [String(error || 'Sending failed').slice(0, 490), id]);
}

// One email — only if this user may see it
export async function findVisible(orgId, id, userId, db = pool) {
  const [rows] = await db.query(
    `SELECT se.*, u.full_name AS sender_name, c.name AS customer_name, i.invoice_number,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name
       FROM sent_emails se
       JOIN users u ON u.id = se.sender_user_id
       LEFT JOIN customers c ON c.id = se.customer_id
       LEFT JOIN invoices i ON i.id = se.invoice_id
       LEFT JOIN employees e ON e.id = se.employee_id
      WHERE se.organization_id = ? AND se.id = ? AND ${VISIBLE}`,
    [orgId, id, userId, userId]
  );
  return rows[0] || null;
}

// The sender sees everyone. Anyone else sees to + cc, and only their OWN bcc line.
export async function listRecipients(emailIds, viewerUserId, senderByEmail, db = pool) {
  if (!emailIds.length) return [];
  const [rows] = await db.query(
    'SELECT email_id, kind, email, name, user_id, customer_id, employee_id FROM sent_email_recipients WHERE email_id IN (?) ORDER BY id',
    [emailIds]
  );
  return rows.filter(
    (r) => r.kind !== 'bcc' || Number(senderByEmail[r.email_id]) === Number(viewerUserId) || Number(r.user_id) === Number(viewerUserId)
  );
}

export async function listAttachments(emailIds, db = pool) {
  if (!emailIds.length) return [];
  const [rows] = await db.query(
    'SELECT id, email_id, file_name, mime_type, size_bytes, file_url FROM sent_email_attachments WHERE email_id IN (?) ORDER BY id',
    [emailIds]
  );
  return rows;
}

// Lists, always limited to what this user may see.
//   box: 'sent' (I sent) | 'received' (sent to me by colleagues) | 'all'
//   customerId / employeeId / invoiceId: emails linked to that record
export async function list(orgId, userId, { box = 'all', customerId, employeeId, invoiceId, search, page = 1, pageSize = 25 }, db = pool) {
  const where = ['se.organization_id = ?', VISIBLE];
  const params = [orgId, userId, userId];
  if (box === 'sent') {
    where.push('se.sender_user_id = ?');
    params.push(userId);
  } else if (box === 'received') {
    where.push('se.sender_user_id <> ?');
    params.push(userId);
  }
  if (customerId) {
    where.push('(se.customer_id = ? OR EXISTS (SELECT 1 FROM sent_email_recipients cr WHERE cr.email_id = se.id AND cr.customer_id = ?))');
    params.push(customerId, customerId);
  }
  if (employeeId) {
    where.push('(se.employee_id = ? OR EXISTS (SELECT 1 FROM sent_email_recipients er WHERE er.email_id = se.id AND er.employee_id = ?))');
    params.push(employeeId, employeeId);
  }
  if (invoiceId) {
    where.push('se.invoice_id = ?');
    params.push(invoiceId);
  }
  if (search) {
    where.push(`(se.subject LIKE ? OR se.body_text LIKE ? OR EXISTS (
      SELECT 1 FROM sent_email_recipients sr WHERE sr.email_id = se.id AND sr.kind <> 'bcc' AND (sr.email LIKE ? OR sr.name LIKE ?)))`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.join(' AND ');
  const [rows] = await db.query(
    `SELECT se.id, se.sender_user_id, se.from_email, se.from_name, se.subject, LEFT(se.body_text, 160) AS snippet,
            se.status, se.error, se.kind, se.customer_id, se.invoice_id, se.employee_id, se.created_at, se.sent_at,
            u.full_name AS sender_name,
            (SELECT COUNT(*) FROM sent_email_attachments a WHERE a.email_id = se.id) AS attachment_count
       FROM sent_emails se
       JOIN users u ON u.id = se.sender_user_id
      WHERE ${whereSql}
      ORDER BY se.created_at DESC, se.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM sent_emails se WHERE ${whereSql}`, params);
  return { rows, total };
}

// Workard users of this company with these email addresses (to decide who can see an email)
export async function usersByEmail(orgId, emails, db = pool) {
  if (!emails.length) return [];
  const [rows] = await db.query(
    `SELECT u.id, LOWER(u.email) AS email FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = ? AND m.status = 'active'
      WHERE LOWER(u.email) IN (?)`,
    [orgId, emails]
  );
  return rows;
}

export async function customersByEmail(orgId, emails, db = pool) {
  if (!emails.length) return [];
  const [rows] = await db.query('SELECT id, LOWER(email) AS email, name FROM customers WHERE organization_id = ? AND LOWER(email) IN (?)', [orgId, emails]);
  return rows;
}

export async function employeesByEmail(orgId, emails, db = pool) {
  if (!emails.length) return [];
  const [rows] = await db.query(
    "SELECT id, LOWER(email) AS email FROM employees WHERE organization_id = ? AND status = 'active' AND LOWER(email) IN (?)",
    [orgId, emails]
  );
  return rows;
}
