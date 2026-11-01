import { env } from './config/env.js'; // must be first: sets the timezone
import app from './app.js';
import { pool } from './config/db.js';
import { cloudinaryEnabled } from './config/cloudinary.js';
import { startScheduler } from './services/schedulerService.js';

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('✔ MySQL connected');
  } catch (err) {
    console.error('✖ Could not connect to MySQL:', err.message);
    process.exit(1);
  }

  if (!env.resend.apiKey) console.log('ℹ RESEND_API_KEY not set — emails will be printed here instead of sent');
  if (!cloudinaryEnabled) console.log('ℹ Cloudinary not set — document & photo uploads are disabled');

  app.listen(env.port, () => {
    console.log(`✔ Workard API running on http://localhost:${env.port} (timezone ${env.timezone})`);
    startScheduler(); // repeating tasks + morning task emails
  });
}

start();
