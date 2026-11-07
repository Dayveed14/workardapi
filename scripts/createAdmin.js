// ============================================================
// Make the FIRST Workard super admin (after that, admins add each other in /admin → Admins).
//
//   npm run admin:create -- --email you@workard.com --name "David Okon"
//
// Already a Workard user? They become an admin and keep their password.
// New email? An account is made and a "set your password" link is emailed AND printed here.
// ============================================================
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { addAdmin } from '../src/services/adminAuthService.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const email = arg('email')?.trim().toLowerCase();
const fullName = arg('name')?.trim();
if (!email || !fullName) {
  console.error('Usage: npm run admin:create -- --email you@workard.com --name "Your Name"');
  process.exit(1);
}

try {
  const result = await addAdmin({ userId: null, userName: 'Workard setup' }, { email, fullName });
  console.log(`✔ ${email} is a Workard super admin.`);
  if (result.setupLink) console.log(`  Set the password here (works for 3 days):\n  ${result.setupLink}`);
  else console.log(`  Log in at ${env.clientUrls[0]}/admin with their existing Workard password.`);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
