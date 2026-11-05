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
//   5. organisations from before plans existed get full access (legacy Enterprise, no end date)
//   6. customers added before stage history get a starting row (for the sales dashboard)
//   7. the owner's own flagged clock-ins are approved (nobody is above them to review)
// Safe to run as many times as you like.
// ============================================================
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { ensureDefaults as ensureReviewDefaults } from '../src/models/reviewModel.js';
import { ensureDefaults as ensureOnboardingDefaults } from '../src/models/onboardingModel.js';
import { backfill as backfillStages } from '../src/models/salesModel.js';
import { ensureLegacy } from '../src/models/subscriptionModel.js';
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
  await ensureOnboardingDefaults(org.id);
  await backfillStages(org.id);
  const [ownerFlags] = await pool.query(
    `UPDATE attendance a
       JOIN employees e ON e.id = a.employee_id
       JOIN memberships m ON m.user_id = e.user_id AND m.organization_id = e.organization_id
       JOIN roles r ON r.id = m.role_id AND r.is_owner = 1
        SET a.review_status = 'approved', a.review_note = 'Owner — no review needed', a.reviewed_at = NOW()
      WHERE a.organization_id = ? AND a.review_status = 'pending'`,
    [org.id]
  );
  const legacy = await ensureLegacy(org.id); // only adds a row if the organisation has none

  console.log(`✔ ${org.name}: ${updated} role(s) updated, invoice/finance/review/onboarding defaults ready${ownerFlags.affectedRows ? ` · ${ownerFlags.affectedRows} owner flag(s) approved` : ''}${legacy ? ' · kept full access (created before plans)' : ''}`);
}

await pool.end();
