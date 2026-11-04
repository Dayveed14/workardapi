import { pool } from '../config/db.js';

export async function listForYear(orgId, year, db = pool) {
  const [rows] = await db.query(
    'SELECT * FROM holidays WHERE organization_id = ? AND YEAR(holiday_date) = ? ORDER BY holiday_date',
    [orgId, year]
  );
  return rows;
}

// Just the dates in a range, e.g. ['2026-10-01'] — used when counting working days
export async function datesInRange(orgId, from, to, db = pool) {
  const [rows] = await db.query(
    'SELECT holiday_date FROM holidays WHERE organization_id = ? AND holiday_date BETWEEN ? AND ?',
    [orgId, from, to]
  );
  return rows.map((r) => r.holiday_date);
}

// INSERT IGNORE: adding a date that's already a holiday does nothing
export async function add(orgId, { date, name }, db = pool) {
  const [result] = await db.query('INSERT IGNORE INTO holidays (organization_id, holiday_date, name) VALUES (?, ?, ?)', [
    orgId,
    date,
    name,
  ]);
  return result.affectedRows === 1;
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM holidays WHERE organization_id = ? AND id = ?', [orgId, id]);
}
