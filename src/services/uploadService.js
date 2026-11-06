import cloudinary, { cloudinaryEnabled } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

function ensureEnabled() {
  if (!cloudinaryEnabled) {
    throw new AppError(503, 'File uploads are not set up yet. Add your Cloudinary keys to the server .env file.');
  }
}

// Uploads a file (from multer memory storage) to Cloudinary.
// Files are grouped per organisation: workard/org_12/documents
export function uploadFile(file, { orgId, subfolder }) {
  ensureEnabled();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${env.cloudinary.folder}/org_${orgId}/${subfolder}`,
        resource_type: 'auto', // images, PDFs and Word files
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) return reject(new AppError(502, 'Upload failed. Please try again.'));
        resolve({ url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type });
      }
    );
    stream.end(file.buffer);
  });
}

export async function deleteFile(publicId, resourceType = 'image') {
  if (!cloudinaryEnabled || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete failed:', err.message); // the DB record is removed anyway
  }
}

// Like uploadFile, but in development WITHOUT Cloudinary small files are kept in the
// database as a data: URL, so features can still be tried locally. Production needs Cloudinary.
export async function storeFile(file, { orgId, subfolder, devMaxKb = 300 }) {
  if (!file) throw new AppError(422, 'Choose a file');
  if (cloudinaryEnabled || env.isProd) {
    const uploaded = await uploadFile(file, { orgId, subfolder });
    return { url: uploaded.url, publicId: uploaded.publicId, resourceType: uploaded.resourceType };
  }
  if (file.size > devMaxKb * 1024) throw new AppError(422, `Without Cloudinary, keep files under ${devMaxKb} KB`);
  return { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, publicId: null, resourceType: null };
}
