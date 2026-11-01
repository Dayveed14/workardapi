import 'dotenv/config';

// Every date in the app ("today", late clock-ins) uses this timezone.
process.env.TZ = process.env.APP_TIMEZONE || 'Africa/Lagos';

const isProd = process.env.NODE_ENV === 'production';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  isProd,
  port: Number(process.env.PORT || 5000),
  timezone: process.env.TZ,
  clientUrls: (process.env.CLIENT_URL || 'http://localhost:5173')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, '')),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'workard',
    ssl: process.env.DB_SSL === 'true',
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshDays: Number(process.env.JWT_REFRESH_DAYS || 7),
  },
  cookieSameSite: process.env.COOKIE_SAMESITE || 'lax',

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'Workard <noreply@fixer.com>',
  },

  // Phase 3 — payroll
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  paystackBaseUrl: (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, ''),
  apiPublicUrl: (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, ''),

  // Phase 3B — lets an outside cron service trigger the daily task jobs (POST /api/jobs/daily)
  cronSecret: process.env.CRON_SECRET || '',

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'workard',
  },
};
