import { pool } from '../config/db.js';

// ============================================================
// Offboardings (someone leaving) and their checklist items
// ============================================================

const SELECT = `
  SELECT o.*, e.first_name, e.last_name, e.job_title, e.photo_url, e.email AS employee_email, e.user_id AS employee_user_id,
         e.manager_id, e.status AS employee_status, d.name AS department_name, u.full_name AS started_by_name,
         (SELECT COUNT(*) FROM offboarding_items i WHERE i.offboarding_id = o.id) AS total_items,
         (SELECT COUNT(*) FROM offboarding_items i WHERE i.offboarding_id = o.id AND i.done_at IS NOT NULL) AS done_items,
         (SELECT COUNT(*) FROM offboarding_items i WHERE i.offboarding_id = o.id AND i.done_at IS NULL AND i.due_at < NOW()) AS overdue_items
    FROM offboardings o
    JOIN employees e ON e.id = o.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN users u ON u.id = o.started_by`;

// Throws ER_DUP_ENTRY when the person is already leaving (UNIQUE employee_id + active_key)
export async function create(orgId, d, db = pool) {
  const [r] = await db.query(
    `INSERT INTO offboardings (organization_id, employee_id, exit_type, reason, started_by, by_employee, notice_start, last_day, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, d.employeeId, d.exitType, d.reason || null, d.startedBy, d.byEmployee ? 1 : 0, d.noticeStart, d.lastDay, d.endsAt]
  );
  return r.insertId;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE o.organization_id = ? AND o.id = ?`, [orgId, id]);
  return rows[0] || null;
}

export async function lock(orgId, id, db) {
  const [rows] = await db.query('SELECT * FROM offboardings WHERE organization_id = ? AND id = ? FOR UPDATE', [orgId, id]);
  return rows[0] || null;
}

// The person's current (or latest) offboarding
export async function findLatestForEmployee(orgId, employeeId, db = pool) {
  const [rows] = await db.query(
    `${SELECT} WHERE o.organization_id = ? AND o.employee_id = ? AND o.status NOT IN ('withdrawn','cancelled')
      ORDER BY o.active_key IS NOT NULL DESC, o.id DESC LIMIT 1`,
    [orgId, employeeId]
  );
  return rows[0] || null;
}

export async function list(orgId, { status }, db = pool) {
  const where = ['o.organization_id = ?'];
  const params = [orgId];
  if (status === 'open') where.push("o.status IN ('notice','in_progress')");
  else if (status) {
    where.push('o.status = ?');
    params.push(status);
  }
  const [rows] = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY o.status IN ('notice','in_progress') DESC, o.status = 'notice' DESC, o.ends_at ASC, o.id DESC LIMIT 300`,
    params
  );
  return rows;
}

export async function update(id, fields, db = pool) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE offboardings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
}

// Finished one way or another: frees the "one live offboarding per person" slot
export async function close(id, status, db = pool) {
  await db.query(
    `UPDATE offboardings SET status = ?, active_key = NULL, exited_at = ${status === 'exited' ? 'NOW()' : 'exited_at'} WHERE id = ?`,
    [status, id]
  );
}

// Everyone whose access should end now (checked by the 15-minute job)
export async function listEnded(db = pool) {
  const [rows] = await db.query("SELECT * FROM offboardings WHERE status IN ('notice','in_progress') AND ends_at <= NOW()");
  return rows;
}

// ---------- Items ----------
export async function addItem(offboardingId, d, db = pool) {
  const [r] = await db.query(
    `INSERT INTO offboarding_items (offboarding_id, title, description, owner, due_at, asks_for_note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM offboarding_items x WHERE x.offboarding_id = ?)))`,
    [offboardingId, d.title, d.description || null, d.owner, d.dueAt || null, d.asksForNote ? 1 : 0, d.sortOrder ?? null, offboardingId]
  );
  return r.insertId;
}

export async function listItems(offboardingId, db = pool) {
  const [rows] = await db.query(
    `SELECT i.*, u.full_name AS done_by_name FROM offboarding_items i LEFT JOIN users u ON u.id = i.done_by
      WHERE i.offboarding_id = ? ORDER BY i.owner = 'hr', i.sort_order, i.id`,
    [offboardingId]
  );
  return rows;
}

export async function findItem(itemId, db = pool) {
  const [rows] = await db.query('SELECT * FROM offboarding_items WHERE id = ?', [itemId]);
  return rows[0] || null;
}

export async function setItemDone(itemId, { userId, done, note }, db = pool) {
  await db.query('UPDATE offboarding_items SET done_at = ?, done_by = ?, note = COALESCE(?, note) WHERE id = ?', [
    done ? new Date() : null,
    done ? userId : null,
    note ?? null,
    itemId,
  ]);
}

export async function removeItem(itemId, db = pool) {
  await db.query('DELETE FROM offboarding_items WHERE id = ?', [itemId]);
}

export async function countOpenItems(offboardingId, db = pool) {
  const [[row]] = await db.query('SELECT COUNT(*) AS n FROM offboarding_items WHERE offboarding_id = ? AND done_at IS NULL', [offboardingId]);
  return Number(row.n);
}

// ---------- Notice period (per company) ----------
export async function noticeDays(orgId, db = pool) {
  const [[row]] = await db.query('SELECT notice_days FROM organizations WHERE id = ?', [orgId]);
  return Number(row?.notice_days ?? 30);
}

export async function setNoticeDays(orgId, days, db = pool) {
  await db.query('UPDATE organizations SET notice_days = ? WHERE id = ?', [days, orgId]);
}
