import { pool } from '../config/db.js';

export async function create({ name, industry, size }, db = pool) {
  const [result] = await db.query('INSERT INTO organizations (name, industry, size) VALUES (?, ?, ?)', [
    name,
    industry || null,
    size || null,
  ]);
  return result.insertId;
}

export async function findById(id, db = pool) {
  const [rows] = await db.query('SELECT * FROM organizations WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function update(id, { name, industry, size }, db = pool) {
  await db.query('UPDATE organizations SET name = ?, industry = ?, size = ? WHERE id = ?', [
    name,
    industry || null,
    size || null,
    id,
  ]);
}
