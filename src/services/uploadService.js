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
