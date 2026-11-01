import { pool } from '../config/db.js';
import { DEFAULT_REVIEW_CRITERIA } from '../config/permissions.js';

// ---------- Settings & criteria ----------
// Creates review settings + default criteria for an organisation if it has none.
export async function ensureDefaults(orgId, db = pool) {
  await db.query('INSERT IGNORE INTO review_settings (organization_id) VALUES (?)', [orgId]);
  const [rows] = await db.query('SELECT COUNT(*) AS n FROM review_criteria WHERE organization_id = ?', [orgId]);
  if (Number(rows[0].n) > 0) return;
  let order = 0;
  for (const c of DEFAULT_REVIEW_CRITERIA) {
    order += 1;
    await db.query(
      'INSERT INTO review_criteria (organization_id, name, description, weight, sort_order) VALUES (?, ?, ?, ?, ?)',
      [orgId, c.name, c.description, c.weight, order]
    );
  }
}

export async function getSettings(orgId, db = pool) {
  const [rows] = await db.query('SELECT * FROM review_settings WHERE organization_id = ?', [orgId]);
  return rows[0] || { organization_id: orgId, frequency: 'monthly', self_review: 1 };
}

export async function updateSettings(orgId, { frequency, selfReview }, db = pool) {
  await db.query(
    `INSERT INTO review_settings (organization_id, frequency, self_review) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE frequency = VALUES(frequency), self_review = VALUES(self_review)`,
    [orgId, frequency, selfReview ? 1 : 0]
  );
}

export async function listCriteria(orgId, db = pool) {
  const [rows] = await db.query(
    'SELECT * FROM review_criteria WHERE organization_id = ? AND is_active = 1 ORDER BY sort_order, id',
    [orgId]
  );
  return rows;
}

// Saves the whole list from the settings form: updates the ones with an id, adds new ones,
// and switches off the ones that were removed (old reviews keep their own copy of names & weights).
export async function saveCriteria(orgId, criteria, db = pool) {
  const keep = [];
  let order = 0;
  for (const c of criteria) {
    order += 1;
    if (c.id) {
      await db.query(
        'UPDATE review_criteria SET name = ?, description = ?, weight = ?, sort_order = ?, is_active = 1 WHERE organization_id = ? AND id = ?',
        [c.name, c.description || null, c.weight, order, orgId, c.id]
      );
      keep.push(c.id);
    } else {
      const [result] = await db.query(
        'INSERT INTO review_criteria (organization_id, name, description, weight, sort_order) VALUES (?, ?, ?, ?, ?)',
        [orgId, c.name, c.description || null, c.weight, order]
      );
      keep.push(result.insertId);
    }
  }
  await db.query(
    `UPDATE review_criteria SET is_active = 0 WHERE organization_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`,
    [orgId, ...keep]
  );
}

// ---------- Reviews ----------
// "e" is the employee being reviewed — permission scopes are applied to it.
const SELECT_REVIEW = `
  SELECT r.*, e.first_name, e.last_name, e.job_title, e.photo_url, e.manager_id,
         u.full_name AS reviewer_name
    FROM reviews r
    JOIN employees e ON e.id = r.employee_id
    LEFT JOIN users u ON u.id = r.reviewer_user_id`;

// Throws ER_DUP_ENTRY if this person already has a live review for the period
export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO reviews (organization_id, employee_id, period, period_start, period_end, status, created_by, active_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, data.employeeId, data.period, data.periodStart, data.periodEnd, data.status, data.createdBy, data.period]
  );
  return result.insertId;
}

export async function addScore(reviewId, criterion, db = pool) {
  await db.query(
    'INSERT INTO review_scores (review_id, criterion_id, name, weight, sort_order) VALUES (?, ?, ?, ?, ?)',
    [reviewId, criterion.id, criterion.name, criterion.weight, criterion.sort_order]
  );
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query(`${SELECT_REVIEW} WHERE r.organization_id = ? AND r.id = ?`, [orgId, id]);
  return rows[0] || null;
}

// Locks the review row while a step is saved, so two people can't move it at the same time
export async function lock(orgId, id, db) {
  const [rows] = await db.query('SELECT * FROM reviews WHERE organization_id = ? AND id = ? FOR UPDATE', [orgId, id]);
  return rows[0] || null;
}

export async function findVisible(orgId, id, visible, db = pool) {
  const [rows] = await db.query(`${SELECT_REVIEW} WHERE r.organization_id = ? AND r.id = ? AND ${visible.sql}`, [
    orgId,
    id,
    ...visible.params,
  ]);
  return rows[0] || null;
}

export async function list(orgId, visible, { period, status, employeeId }, db = pool) {
  const where = ['r.organization_id = ?', visible.sql];
  const params = [orgId, ...visible.params];
  if (period) {
    where.push('r.period = ?');
    params.push(period);
  }
  if (status === 'open') where.push("r.status IN ('self_review','manager_review','acknowledgement')");
  else if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (employeeId) {
    where.push('r.employee_id = ?');
    params.push(employeeId);
  }
  const [rows] = await db.query(
    `${SELECT_REVIEW} WHERE ${where.join(' AND ')} ORDER BY r.period DESC, e.first_name, e.last_name LIMIT 300`,
    params
  );
  return rows;
}

export async function update(id, fields, db = pool) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  await db.query(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
}

export async function listScores(reviewId, db = pool) {
  const [rows] = await db.query('SELECT * FROM review_scores WHERE review_id = ? ORDER BY sort_order, id', [reviewId]);
  return rows;
}

export async function setScore(reviewId, scoreId, fields, db = pool) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  await db.query(`UPDATE review_scores SET ${sets.join(', ')} WHERE review_id = ? AND id = ?`, [
    ...Object.values(fields),
    reviewId,
    scoreId,
  ]);
}

// This period's review (if any) for each employee in `employeeIds`
export async function activeForPeriod(orgId, period, db = pool) {
  const [rows] = await db.query(
    "SELECT id, employee_id, status, overall_score FROM reviews WHERE organization_id = ? AND period = ? AND status <> 'cancelled'",
    [orgId, period]
  );
  return rows;
}

// How many reviews are waiting on this person: their own (self-assessment / confirm),
// and — as a manager — reviews inside `managed` that need writing
export async function countWaiting(orgId, employeeId, managed, db = pool) {
  const [rows] = await db.query(
    `SELECT
       SUM(r.employee_id = ? AND r.status IN ('self_review','acknowledgement')) AS mine,
       SUM(r.employee_id <> ? AND r.status = 'manager_review' AND ${managed.sql}) AS to_write
     FROM reviews r JOIN employees e ON e.id = r.employee_id
     WHERE r.organization_id = ? AND r.status IN ('self_review','manager_review','acknowledgement')`,
    [employeeId, employeeId, ...managed.params, orgId]
  );
  return { mine: Number(rows[0].mine || 0), toWrite: Number(rows[0].to_write || 0) };
}
