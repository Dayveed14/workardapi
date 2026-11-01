// ============================================================
// Brings EXISTING organisations up to date after a new phase.
//   npm run db:sync
//
// For every organisation it:
//   1. gives the built-in roles any NEW default permissions
//      (never removes anything an admin changed)
//   2. gives the Owner role every permission
//   3. creates invoice settings and finance categories if missing
//   4. creates review settings and default review criteria if missing
// Safe to run as many times as you like.
// ============================================================
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { ensureDefaults as ensureReviewDefaults } from '../src/models/reviewModel.js';
import { DEFAULT_ROLES, PERMISSION_KEYS, DEFAULT_FINANCE_CATEGORIES } from '../src/config/permissions.js';

const [orgs] = await pool.query('SELECT id, name FROM organizations');

for (const org of orgs) {
  const [roles] = await pool.query('SELECT * FROM roles WHERE organization_id = ? AND is_system = 1', [org.id]);
  let updated = 0;

  for (const role of roles) {
    const current = JSON.parse(role.permissions || '{}');
    const defaults = role.is_owner
      ? Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'all']))
      : DEFAULT_ROLES.find((d) => d.name === role.name)?.permissions || {};

    const merged = { ...defaults, ...current }; // admin's choices win
    if (role.is_owner) Object.assign(merged, defaults);

    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      await pool.query('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(merged), role.id]);
      updated += 1;
    }
  }

  await pool.query('INSERT IGNORE INTO invoice_settings (organization_id) VALUES (?)', [org.id]);
  for (const [type, names] of Object.entries(DEFAULT_FINANCE_CATEGORIES)) {
    for (const name of names) {
      await pool.query('INSERT IGNORE INTO finance_categories (organization_id, type, name) VALUES (?, ?, ?)', [
        org.id,
        type,
        name,
      ]);
    }
  }

  await ensureReviewDefaults(org.id);

  console.log(`✔ ${org.name}: ${updated} role(s) updated, invoice/finance/review defaults ready`);
}

await pool.end();
