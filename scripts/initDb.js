// Creates the database and all tables from db/schema.sql
// Usage: npm run db:init
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbName = process.env.DB_NAME || 'workard';

let sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
sql = sql
  .replace('CREATE DATABASE IF NOT EXISTS workard', `CREATE DATABASE IF NOT EXISTS \`${dbName}\``)
  .replace('USE workard;', `USE \`${dbName}\`;`);

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  multipleStatements: true,
});

await conn.query(sql);

// Changes to existing tables (new ENUM values etc.) — safe to run every time
const upgrades = fs.readFileSync(path.join(__dirname, '..', 'db', 'upgrades.sql'), 'utf8');
await conn.query(`USE \`${dbName}\`; ${upgrades}`);
await conn.end();
console.log(`✔ Database "${dbName}" is ready`);
