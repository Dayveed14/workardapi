import { env } from '../config/env.js';

export function notFound(req, res) {
  res.status(404).json({ message: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // File too large (multer)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(422).json({ message: 'File is too large' });
  }
  // Duplicate value in a UNIQUE column
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ message: 'That record already exists' });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err);

  res.status(status).json({
    message: status >= 500 && env.isProd ? 'Something went wrong' : err.message,
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.appCode ? { code: err.appCode } : {}),
  });
}
