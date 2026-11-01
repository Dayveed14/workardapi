import mysql from 'mysql2/promise';
import { env } from './env.js';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // dates come back as plain strings, e.g. "2026-11-02 08:05:00"
});

// Runs several queries as one unit: all succeed or none do.
// Models accept an optional `db` argument so they can run inside a transaction.
//
// If MySQL picks this transaction as the loser of a deadlock (two requests
// locking the same rows at the same moment), it is safely retried — up to 3 times.
// Nothing was saved by the failed attempt, so retrying can't double anything.
export async function withTransaction(work) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOnce(work);
    } catch (err) {
      if (err.code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 70)); // short random wait
    }
  }
}

async function runOnce(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
