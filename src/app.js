import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { applySettings } from './services/platformSettingsService.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { paystackWebhook } from './controllers/payrollController.js';
import { webhook as billingWebhook } from './controllers/billingController.js';

const app = express();

// Prices & trial length the super admin saved (over the defaults in config/plans.js)
applySettings().catch((err) => console.error('Could not load platform settings:', err.message));

app.set('trust proxy', env.trustProxy); // real client IP (office Wi-Fi checks, rate limits) — see TRUST_PROXY in .env.example
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || env.clientUrls.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
// Paystack webhook: needs the RAW body to check the signature, so it comes before express.json()
app.post('/api/webhooks/paystack/:orgId', express.raw({ type: '*/*', limit: '200kb' }), paystackWebhook);
// Workard's own Paystack account: organisations paying for their yearly plan
app.post('/api/webhooks/paystack-billing', express.raw({ type: '*/*', limit: '200kb' }), billingWebhook);

// Blog posts can be long (and hold small images while developing without Cloudinary)
app.use('/api/admin/blog', express.json({ limit: '3mb' }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
