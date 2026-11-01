import { pool } from '../config/db.js';

const FIELDS = [
  'name',
  'address',
  'latitude',
  'longitude',
  'radius_m',
  'office_ips',
  'clock_in_policy',
  'work_start',
  'work_end',
  'grace_minutes',
];

// { radiusM: 150 } → [radius_m value] in FIELDS order
function values(data) {
  return [
    data.name,
    data.address || null,
    data.latitude ?? null,
    data.longitude ?? null,
    data.radiusM ?? 150,
    data.officeIps || null,
    data.clockInPolicy || 'either',
    data.workStart || '08:00:00',
    data.workEnd || '17:00:00',
    data.graceMinutes ?? 15,
  ];
}

export async function listByOrg(orgId, db = pool) {
  const [rows] = await db.query(
    `SELECT b.*, (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.status = 'active') AS employee_count
       FROM branches b WHERE b.organization_id = ? ORDER BY b.name`,
    [orgId]
  );
  return rows;
}

export async function findById(orgId, id, db = pool) {
  const [rows] = await db.query('SELECT * FROM branches WHERE organization_id = ? AND id = ?', [orgId, id]);
  return rows[0] || null;
}

export async function create(orgId, data, db = pool) {
  const [result] = await db.query(
    `INSERT INTO branches (organization_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
    [orgId, ...values(data)]
  );
  return result.insertId;
}

export async function update(orgId, id, data, db = pool) {
  await db.query(
    `UPDATE branches SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE organization_id = ? AND id = ?`,
    [...values(data), orgId, id]
  );
}

export async function remove(orgId, id, db = pool) {
  await db.query('DELETE FROM branches WHERE organization_id = ? AND id = ?', [orgId, id]);
}
